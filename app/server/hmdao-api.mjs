// LEGACY NOTICE:
// Unreal Pixel Streaming proxy, player.html rewrite, and frontend bootstrap are kept only for explicit legacy compatibility.
// The normal Unreal path should stay on HMDao Unreal Capture + /ws/dcc/unreal editor-direct bridging.
import './lib/load-env.mjs'; // 最先加载：读取 app/.env 注入 process.env（零依赖）
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import {
  promises as fs,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildPlatformInfo,
  gmicManagedInstallSupport,
  isForbiddenInstallTarget,
  platformExecutableCandidates,
  resolveYtDlpAssetNames,
  selectPypiWheelPlatformRegex,
} from './platform-utils.mjs';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { createDccEnvironmentManager } from './dcc-plugin-manager.mjs';
import { createUnrealPixelStreamingLegacyModule } from './dcc/unreal-pixel-streaming-legacy.mjs';
import {
  getMemory,
  setMemory,
  setAllMemory,
  deleteMemory,
  memoryContextString,
} from './lib/agent-memory-store.mjs';

// 火山方舟推理接入点管理已抽离为独立模块（缓存私有化 + 原子写 + 超时 + 自愈入口）。
// 见 app/server/providers/ark.mjs：resolveArkModel / getArkEndpointInfo / getAllArkEndpoints /
// syncArkEndpoints / invalidateArkEndpoint（自愈入口，运行期接线为后续步骤）/ rebuildSingleArkEndpoint。
import {
  resolveArkModel,
  syncArkEndpoints,
} from './providers/ark.mjs';
// 统一原子写 JSON 持久化基础设施。
// 纯认证工具函数（从主文件剥离，行为零变更）。
import {
  normalizeLocalEmail,
  isValidLocalEmail,
  hashPassword,
  verifyPassword,
  publicUser,
} from './lib/auth-utils.mjs';
// 媒体代理纯工具函数（从主文件剥离，行为零变更）。
import {
  inferMediaContentType,
  mediaMimeTypeFromExtension,
  looksLikeHtml,
  sanitizeForwardHeaderValue,
  getRemoteSignedUrlExpiry,
  createMediaProxyErrorPayload,
  normalizeHttpUrl,
  readHeaderValue,
} from './lib/media-utils.mjs';
// 纯字符串/Shell 工具函数（从主文件剥离，行为零变更；services/* 经 deps 注入复用）。
import {
  extractFirstString,
  uniqueStrings,
  escapePowerShellSingleQuoted,
  escapeXml,
  extractJsonObjectFromText,
} from './lib/str-utils.mjs';
import {
  buildSafeInlineContentDisposition,
  sanitizeLocalAssetId,
  sanitizeMultipartFieldName,
  parseStringArrayField,
  parseInlineDataUrl,
  isManagedPublicRelayAssetUrl,
  isTemporaryTunnelHost,
  isApimartBaseUrl,
} from './lib/parse-utils.mjs';
import {
  isPrivateOrLocalHostname,
  extractManagedLocalRoutePath,
  isPublicRemoteMediaUrl,
  isLocalOnlyMediaReference,
} from './lib/media-url-utils.mjs';
// 目录归一化 + relay 模态推断（含从 byokService 下沉的纯函数，行为零变更）。
import { inferMode } from './lib/catalog-utils.mjs';
import { sha256 } from './lib/crypto-utils.mjs';
import { imageExtensionFromMimeType } from './lib/media-utils.mjs';
// WebSocket 帧编解码纯工具（从主文件剥离，行为零变更）。
import {
  wsAcceptKey,
  encodeWsFrame,
  createFrameParser,
  sendWs,
} from './lib/ws-frame-utils.mjs';
// 纯对象/代理错误分类工具（从主文件剥离，行为零变更）。
import {
  compactObject,
  classifyProxyError,
  normalizeAspectRatio,
  stripInternalGenerationFields,
} from './lib/object-utils.mjs';
import { extractApimartTaskId, normalizeApimartTaskPhase, apimartTaskStatusCandidates, apimartVideoSize, apimartVideoAspectRatio, rawAspectRatioFromResolution, apimartKlingMode, isApimartKlingVideoModelKind, isStrictImageSubjectSwapOperation, apimartImageSize, apimartImageResolution, assetCoverageRoles, apimartExpandedImageRoles } from './lib/apimart-payload-utils.mjs';
import { buildApimartTaskResultPayload, apimartTaskStatusValue, extractApimartAsyncFailureMessage } from './lib/apimart-task-result.mjs';
import { normalizeReferenceAssets, buildApimartImageRoleEntries, buildApimartOrderedImageUrls, buildApimartImagePromptContract, buildApimartVideoRoleEntries, buildApimartAudioUrls } from './lib/apimart-role-builders.mjs';
import { apimartVideoModelKind, apimartImageModelKind, shouldRouteApimartVideoEditToHappyhorse } from './lib/apimart-model-kind.mjs';
// 会话存储（sessions / accessSessions / createSession / deleteSessionsForUser），从主文件
// 抽离。ES 模块 live binding：主文件与各路由组共享同一批 Map 实例，行为零变更。
import {
  sessions,
  accessSessions,
  createSession,
  deleteSessionsForUser,
  loadSessions,
} from './lib/session-store.mjs';
// 路由注册表：替代 route() 中的顺序 if 链，路由组按 routes/ 目录逐步外移。
import { createHttpRouter } from './core/http-router.mjs';
import { registerHealthRoutes } from './routes/health.mjs';
import { registerAuthRoutes } from './routes/auth.mjs';
import { registerExtensionLicenseRoutes } from './routes/extension-license.mjs';
import { registerByokRoutes } from './routes/byok.mjs';
import { registerAria2Routes } from './routes/aria2.mjs';
import * as aria2Manager from './lib/aria2-manager.mjs';
import { registerModelsRoutes } from './routes/models.mjs';
import { registerAssetsRoutes } from './routes/assets.mjs';
import { registerDccRoutes } from './routes/dcc.mjs';
import { registerMediaRoutes } from './routes/media.mjs';
import { registerCobuildRoutes } from './routes/cobuild.mjs';
import { registerSearchRoutes } from './routes/search.mjs';
import { registerLocalAiRoutes } from './routes/local-ai.mjs';
import { registerAgentRoutes } from './routes/agent.mjs';
import { registerNetdiskRoutes } from './routes/netdisk.mjs';
import { registerNetdiskScrapeRoutes } from './routes/netdisk-scrape.mjs';
import { createAssetLibraryService } from './services/assetLibrary.mjs';

const PORT = Number(process.env.HMDAO_API_PORT || 8792);
// P1-10：基础路径常量收敛至 lib/server-paths.mjs 单点导出（值与原定义逐字节一致）。
import { APP_DIR, REPO_ROOT, DATA_DIR } from './lib/server-paths.mjs';
import {
  IMAGE_OPERATION_DISPATCH,
  buildDefaultOperationDispatchConfig,
  normalizeOperationDispatchConfig,
  buildVideoSourceConstraint,
  isApimartRelayEndpoint,
  normalizeIdentityController,
  modelSupportsRequirement,
  capabilityPenalty,
  expandedReferenceRoles,
  referenceRoleRoutingScore,
  videoGenerationModeRoutingScore,
} from './lib/operation-dispatch-utils.mjs';
const LOCAL_VIDEO_EDIT_DIR = path.join(DATA_DIR, 'local-video-edits');
const LOCAL_VIDEO_RESULT_DIR = path.join(DATA_DIR, 'local-video-results');
const LOCAL_AUDIO_EDIT_DIR = path.join(DATA_DIR, 'local-audio-edits');
const LOCAL_AUDIO_RESULT_DIR = path.join(DATA_DIR, 'local-audio-results');
const LOCAL_IMAGE_ANALYSIS_DIR = path.join(DATA_DIR, 'local-image-analysis');
const LOCAL_POST_EDIT_DIR = path.join(DATA_DIR, 'local-post-edits');
const COMFYUI_TEMP_DIR = path.join(DATA_DIR, 'comfyui-tmp');
const COMFYUI_TEMP_TTL_MS = Number(process.env.HMDAO_COMFYUI_TEMP_TTL_MS || 30 * 60 * 1000);
const LOCAL_POST_RESULT_DIR = path.join(DATA_DIR, 'local-post-results');
const LOCAL_VIDEO_PARSE_SCRIPT = path.resolve(APP_DIR, 'server', 'local_video_parse.py');
const LOCAL_VIDEO_REMOVE_SUBTITLE_SCRIPT = path.resolve(APP_DIR, 'server', 'local_video_remove_subtitle.py');

// P1：hf-proxy 磁盘缓存（NLLB 等大模型文件服务端落盘，浏览器重试/弱网可同源秒取）
const HF_PROXY_CACHE_DIR = path.resolve(DATA_DIR, 'hf-proxy-cache');
const hfProxyCacheLocks = new Set();
function ensureHfProxyCacheDir() {
  if (!existsSync(HF_PROXY_CACHE_DIR)) {
    try { fs.mkdirSync(HF_PROXY_CACHE_DIR, { recursive: true }); } catch { /* noop */ }
  }
  return HF_PROXY_CACHE_DIR;
}
// 已知需预热的模型文件清单：浏览器「一键安装」前由后端异步拉取落盘，绕开美国 CDN 慢链路
const HF_PROXY_PREWARM = {
  'Xenova/nllb-200-distilled-600M': [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'vocab.json',
    'merges.txt',
    'encoder_model.onnx',
    'decoder_model.onnx',
    'decoder_with_past_model.onnx',
  ],
};
const DEFAULT_ASSET_LIBRARY_STORAGE_DIR = process.env.HMDAO_ASSET_LIBRARY_DIR
  ? path.resolve(APP_DIR, process.env.HMDAO_ASSET_LIBRARY_DIR)
  : path.join(DATA_DIR, 'asset-library-files');
const ASSET_LIBRARY_SETTINGS_FILE = path.join(DATA_DIR, 'asset-library-settings.json');
const ASSET_LIBRARY_CATALOG_FILE = path.join(DATA_DIR, 'asset-library-catalog.json');

// Free image search API base URLs
const UNSPLASH_BASE = 'https://api.unsplash.com';
const PEXELS_BASE = 'https://api.pexels.com';
const PIXABAY_BASE = 'https://pixabay.com/api';
const OPENVERSE_BASE = 'https://api.openverse.org/v1';
const WIKIMEDIA_BASE = 'https://commons.wikimedia.org/w/api.php';
const ASSET_LIBRARY_TEMP_DIR = path.join(DATA_DIR, 'asset-library-imports');
const APIMART_CONDITIONING_DIR = path.join(DATA_DIR, 'apimart-conditioning');
const ACTIVATED_PROVIDERS_FILE = path.join(DATA_DIR, 'activated-providers.json');
const RELAY_HTTP_TEMP_DIR = path.join(DATA_DIR, 'relay-http');
const OPERATION_DISPATCH_CONFIG_FILE = process.env.HMDAO_OPERATION_DISPATCH_CONFIG
  ? path.resolve(APP_DIR, process.env.HMDAO_OPERATION_DISPATCH_CONFIG)
  : path.resolve(APP_DIR, 'server', 'operation-dispatch.config.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COBUILD_FILE = path.join(DATA_DIR, 'cobuild.json');
const UNREAL_CONFIG_FILE = path.join(DATA_DIR, 'unreal-config.json');
const activatedProviders = new Map();
// [migrated to ./services/byokService.mjs] let activatedProvidersHydrated = false;
const workflowRuns = new Map();
const workflowSocketSubscriptions = new Map();
const catalogSocketSubscriptions = new Map();
const polyhavenCatalogCache = new Map();
const ENABLE_UNREAL_PIXEL_STREAMING_LEGACY = process.env.HMDAO_ENABLE_UNREAL_PIXEL_STREAMING_LEGACY === '1';

const providers = [
  { id: 'deepseek', name: 'DeepSeek', domestic: true, modes: ['llm'] },
  { id: 'siliconflow', name: '硅基流动', domestic: true, modes: ['llm', 'image', 'video'] },
  { id: 'zhipu', name: 'Zhipu AI', domestic: true, modes: ['llm', 'image', 'video'] },
  { id: 'bailian', name: 'Bailian', domestic: true, modes: ['llm', 'image', 'video', 'audio'] },
  { id: 'minimax', name: 'MiniMax', domestic: true, modes: ['llm', 'audio'] },
  { id: 'volcengine', name: '火山方舟', domestic: true, modes: ['llm', 'image', 'video', 'audio'] },
  { id: 'kling', name: 'Kling AI', domestic: true, modes: ['image', 'video'] },
  { id: 'modelscope', name: 'ModelScope', domestic: true, modes: ['llm', 'image', 'video'] },
  { id: 'openai', name: 'OpenAI', domestic: false, modes: ['llm', 'image'] },
  { id: 'fal', name: 'fal.ai', domestic: false, modes: ['image', 'video'] },
  { id: 'replicate', name: 'Replicate', domestic: false, modes: ['image', 'video'] },
  { id: 'comfyui', name: 'ComfyUI', domestic: true, modes: ['image', 'video', 'audio'] },
];

const PROVIDER_BASE_URLS = {
  deepseek: 'https://api.deepseek.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  minimax: 'https://api.minimax.chat/v1',
  openai: 'https://api.openai.com/v1',
  kling: 'https://api.klingai.com/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  modelscope: 'https://api-inference.modelscope.cn/v1',
  fal: 'https://fal.run',
  replicate: 'https://api.replicate.com/v1',
};

// ==================== 模型目录自动对账（已迁移至 ./services/catalogReconcile.mjs）====================
// 对账服务依赖 BYOK 服务函数，接线位于 byok 服务块之后。

// ==================== 模型目录数据（已迁移至 ./services/modelCatalogData.mjs） ====================
import { MODEL_CATALOG, QWEN3_TTS_VOICES } from './services/modelCatalogData.mjs';

let operationDispatchConfigCache = null;
let operationDispatchConfigCacheMtime = 0;

async function loadOperationDispatchConfig({ force = false } = {}) {
  let stat = null;
  try {
    stat = await fs.stat(OPERATION_DISPATCH_CONFIG_FILE);
  } catch {
    stat = null;
  }

  if (!force && operationDispatchConfigCache) {
    const currentMtime = stat?.mtimeMs || 0;
    if (currentMtime === operationDispatchConfigCacheMtime) {
      return operationDispatchConfigCache;
    }
  }

  try {
    const raw = await fs.readFile(OPERATION_DISPATCH_CONFIG_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    operationDispatchConfigCache = normalizeOperationDispatchConfig(parsed);
    operationDispatchConfigCacheMtime = stat?.mtimeMs || Date.now();
    return operationDispatchConfigCache;
  } catch {
    operationDispatchConfigCache = buildDefaultOperationDispatchConfig();
    operationDispatchConfigCacheMtime = stat?.mtimeMs || 0;
    return operationDispatchConfigCache;
  }
}

async function saveOperationDispatchConfig(config) {
  const normalized = normalizeOperationDispatchConfig(config);
  const payload = JSON.stringify(normalized, null, 2);
  await fs.mkdir(path.dirname(OPERATION_DISPATCH_CONFIG_FILE), { recursive: true });
  await fs.writeFile(OPERATION_DISPATCH_CONFIG_FILE, payload, 'utf8');
  const stat = await fs.stat(OPERATION_DISPATCH_CONFIG_FILE).catch(() => null);
  operationDispatchConfigCache = normalized;
  operationDispatchConfigCacheMtime = stat?.mtimeMs || Date.now();
  return normalized;
}

// 资产库服务已外移至 app/server/services/assetLibrary.mjs（工厂注入 deps）。
const assetLibraryService = createAssetLibraryService({
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
});
const {
  sanitizeAssetFileBaseName,
  inferAssetTypeFromMime,
  inferAssetTypeFromPath,
  buildAssetLibraryContentUrl,
  normalizeAssetDuplicateValue,
  buildAssetDuplicateFingerprint,
  findDuplicateAssetLibraryItem,
  mergeDuplicateAssetCandidate,
  readAssetLibrarySettings,
  writeAssetLibrarySettings,
  pickLocalDirectory,
  readAssetLibraryCatalog,
  writeAssetLibraryCatalog,
  upsertAssetLibraryItem,
  writeAssetLibraryDuplicates,
  readAssetLibraryDuplicates,
  probeAssetMedia,
  repairAssetLibraryItem,
  deleteAssetLibraryItems,
  pruneMissingAssetLibraryItems,
  restoreAssetLibraryItems,
  findAssetLibraryItem,
  processAssetLibraryImportDirectory,
} = assetLibraryService;

const DCC_ENGINES = {
  blender: { id: 'blender', label: 'Blender', port: 8766, pluginName: 'HMDao Blender Capture Plugin' },
  unreal: { id: 'unreal', label: 'Unreal Engine', port: 8792, pluginName: 'HMDao Unreal Capture Plugin', wsPath: '/ws/dcc/unreal', previewProvider: 'editor-direct' },
};

const DEFAULT_UNREAL_PIXEL_URL = process.env.HMDAO_UNREAL_PIXEL_URL || 'http://127.0.0.1:1025/player.html';
const DEFAULT_UNREAL_REMOTE_URL = process.env.HMDAO_UNREAL_REMOTE_URL || 'http://127.0.0.1:30010';

const DCC_CAMERA_SETS = {
  blender: ['Main Camera', 'Product Closeup', 'Orbit Camera'],
  unreal: ['CineCameraActor_01', 'CineCameraActor_02', 'Sequencer_Camera'],
};

const DCC_RECORDING_LOCK = { engine: null };
// 多用户隔离：每个 owner（默认 'local' 兼容本机单用户）拥有独立的 DCC 桥接桶，
// 插件流与浏览器流按 owner 分桶，互不串流。owner 取自 WS query 的 ?owner= 或鉴权 token。
const UNREAL_DIRECT_BRIDES = new Map();
const DCC_LOCAL_ARTIFACTS = new Map();

function resolveDccOwner(raw) {
  const owner = typeof raw === 'string' ? raw.trim() : '';
  return owner && /^[A-Za-z0-9_-]{1,64}$/.test(owner) ? owner : 'local';
}

function getUnrealDirectBridge(owner) {
  const key = resolveDccOwner(owner);
  let bridge = UNREAL_DIRECT_BRIDES.get(key);
  if (!bridge) {
    bridge = {
      owner: key,
      pluginSocket: null,
      pluginInfo: null,
      browsers: new Map(),
      lastCameraList: null,
      lastTimeline: null,
    };
    UNREAL_DIRECT_BRIDES.set(key, bridge);
  }
  return bridge;
}

// 从 DCC WebSocket 握手的 query 解析 owner。
// 优先级：?token=<accessToken>（云端多用户隔离，从登录态解析 userId）> ?owner=<任意串>（向后兼容）> 本机回退 'local'。
// 注意：浏览器 WS 无法设置自定义头，故 token 走 query；本机插件不传 token 时回退 local 桶以保持单机兼容。
function resolveDccOwnerFromWs(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = (url.searchParams.get('token') || '').toString().trim();
  if (token) {
    const entry = accessSessions.get(token);
    if (entry && (!entry.expiresAt || Date.now() <= entry.expiresAt)) {
      const uid = String(entry.userId || '').trim();
      if (/^[A-Za-z0-9_-]{1,64}$/.test(uid)) return uid;
    }
  }
  return resolveDccOwner(url.searchParams.get('owner'));
}

// 是否允许无鉴权（本机 127.0.0.1/localhost）回退到 local 桶。
// 云端部署（非本机 HOST）下，未带有效 token 的连接一律拒绝，避免串流/越权。
function isDccLocalOnlyConnection(req) {
  const host = (req.headers.host || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function isSyntheticUnrealDirectPluginSession(bridge) {
  return String(bridge?.pluginInfo?.pluginVersion || '').trim().toLowerCase() === 'verify';
}

function isUnrealDirectBridgeOnline(bridge) {
  if (isSyntheticUnrealDirectPluginSession(bridge)) return false;
  return Boolean(bridge?.pluginSocket && !bridge.pluginSocket.destroyed);
}

function getUnrealDirectBridgeCameraCount(bridge) {
  const cameraList = bridge?.lastCameraList;
  if (Array.isArray(cameraList?.camera_list)) return cameraList.camera_list.length;
  if (Array.isArray(cameraList?.cameras)) return cameraList.cameras.length;
  return 0;
}

function registerDccLocalArtifactUrl(filePath, mimeType = 'application/octet-stream') {
  const normalizedPath = path.resolve(String(filePath || '').trim());
  if (!normalizedPath) return '';
  const now = Date.now();
  const token = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.createHash('sha1').update(`${mimeType}:${normalizedPath}:${now}:${Math.random()}`).digest('hex');
  DCC_LOCAL_ARTIFACTS.set(token, {
    filePath: normalizedPath,
    mimeType: String(mimeType || 'application/octet-stream') || 'application/octet-stream',
    updatedAt: now,
  });
  for (const [existingToken, entry] of DCC_LOCAL_ARTIFACTS.entries()) {
    if ((now - Number(entry?.updatedAt || 0)) > 6 * 60 * 60 * 1000) {
      DCC_LOCAL_ARTIFACTS.delete(existingToken);
    }
  }
  return `/api/dcc/local-artifacts/${token}`;
}

function getDccLocalArtifact(token = '') {
  return DCC_LOCAL_ARTIFACTS.get(String(token || '').trim()) || null;
}

function getRequestOrigin(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http');
  const host = forwardedHost || String(req?.headers?.host || `127.0.0.1:${PORT}`).split(',')[0].trim() || `127.0.0.1:${PORT}`;
  return `${protocol}://${host}`;
}

function summarizeCurrentUnrealEnvironment(pluginEngine) {
  if (!pluginEngine) return null;
  const hostProcessRunning = Boolean(pluginEngine?.host?.hostProcessRunning);
  const targetProjectRunning = Boolean(pluginEngine?.host?.targetProjectRunning);
  const directBridgeReadyForTargetProject = Boolean(pluginEngine?.plugin?.directBridgeReadyForTargetProject);
  const adapterSummary = String(pluginEngine?.summary || '').trim();
  if (pluginEngine?.integration?.recommendedMode === 'official-sequencer-capture') {
    return {
      level: pluginEngine.level,
      summary: pluginEngine.summary,
      recommendedAction: pluginEngine.recommendedAction,
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
      integration: pluginEngine.integration || null,
      official: pluginEngine.official || null,
      guidance: pluginEngine.guidance || null,
    };
  }
  if (!targetProjectRunning) {
    return {
      level: 'warning',
      summary: hostProcessRunning
        ? (adapterSummary || 'Unreal is already running and HMDao is still waiting to identify the current editor session. Confirm the visible main window is fully open, then click Connect again.')
        : 'The target Unreal project is not open in the current running editor session yet. Open the matching project from Epic Games Launcher, wait for the visible editor window, then click Connect again in HMDao.',
      recommendedAction: 'connect',
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
    };
  }
  const prerequisitesReady = Boolean(
    pluginEngine?.plugin?.installed
    && pluginEngine?.plugin?.enabledInProject
    && pluginEngine?.plugin?.buildArtifactsPresent,
  );
  if (!prerequisitesReady) {
    return {
      level: pluginEngine.level,
      summary: pluginEngine.summary,
      recommendedAction: pluginEngine.recommendedAction,
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
    };
  }
  if (!directBridgeReadyForTargetProject || !isUnrealDirectBridgeOnline(getUnrealDirectBridge('local'))) {
    return {
      level: 'warning',
      summary: 'The plugin is ready, but Unreal has not bridged the editor back to HMDao yet.',
      recommendedAction: 'connect',
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
    };
  }
  if (getUnrealDirectBridgeCameraCount(getUnrealDirectBridge('local')) <= 0) {
    return {
      level: 'warning',
      summary: 'Unreal is connected back to HMDao, but no viewport or camera source has been reported yet. Even without an explicit camera, it should normally fall back to Editor Viewport.',
      recommendedAction: 'connect',
      adapter: pluginEngine.adapter || null,
    };
  }
  return {
    level: 'ready',
    summary: 'Unreal plugin install, project enablement, and direct bridge are all ready.',
    recommendedAction: 'ready',
    adapter: pluginEngine.adapter || null,
    runtimeState: pluginEngine.runtimeState || null,
    integration: pluginEngine.integration || null,
    official: pluginEngine.official || null,
    guidance: pluginEngine.guidance || null,
  };
}

function logUnrealBridgeEvent(event, details = null) {
  if (!details || typeof details !== 'object') {
    console.log(`[HMDao Unreal Bridge] ${event}`);
    return;
  }
  try {
    console.log(`[HMDao Unreal Bridge] ${event} ${JSON.stringify(details)}`);
  } catch {
    console.log(`[HMDao Unreal Bridge] ${event}`);
  }
}

const DCC_ENVIRONMENT_MANAGER = createDccEnvironmentManager({
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  getUnrealBridgeState: () => {
    const local = getUnrealDirectBridge('local');
    return {
      directBridgeOnline: isUnrealDirectBridgeOnline(local),
      clientCount: local.browsers.size,
      pluginInfo: isSyntheticUnrealDirectPluginSession(local) ? null : local.pluginInfo,
      cameraList: local.lastCameraList,
    };
  },
  // 云端多用户隔离：写连接意图文件时的 token 回退来源。
  // 主路径已由 DCC action 路由通过 runAction({ connectToken }) 参数透传（见 routes/dcc.mjs），
  // 此处回调仅作兜底（兼容非 REST 调用方）。不再依赖 globalThis 全局变量——
  // 非 REST 调用方无 owner 上下文，无法安全解析 token，统一回退空串（由 adapter 落为本机 local 桶）。
  resolveConnectToken: () => '',
});

function engineConfig(engine) {
  return DCC_ENGINES[engine === 'unreal' ? 'unreal' : 'blender'];
}

function dccFrameDataUrl({ engine, cameraName, width, height, frameIndex, recording }) {
  const config = engineConfig(engine);
  const hue = engine === 'unreal' ? '#2563eb' : '#0f766e';
  const accent = engine === 'unreal' ? '#f97316' : '#22d3ee';
  const tick = frameIndex % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#050505"/>
        <stop offset="0.52" stop-color="${hue}"/>
        <stop offset="1" stop-color="#111827"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <circle cx="${Math.round(width * (0.18 + (tick % 80) / 400))}" cy="${Math.round(height * 0.34)}" r="${Math.round(Math.min(width, height) * 0.14)}" fill="${accent}" opacity="0.24"/>
    <rect x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.16)}" width="${Math.round(width * 0.84)}" height="${Math.round(height * 0.58)}" rx="18" fill="rgba(0,0,0,0.26)" stroke="rgba(255,255,255,0.26)" stroke-width="2"/>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.28)}" fill="#ffffff" font-family="Arial, sans-serif" font-size="${Math.max(24, Math.round(width / 24))}" font-weight="700">${escapeXml(config.label)} Camera Preview</text>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.38)}" fill="#d1fae5" font-family="Arial, sans-serif" font-size="${Math.max(18, Math.round(width / 38))}">${escapeXml(cameraName)}</text>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.48)}" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="${Math.max(16, Math.round(width / 48))}">Frame ${frameIndex} · ${width} x ${height}${recording ? ' · REC' : ''}</text>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.62)}" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="${Math.max(14, Math.round(width / 58))}">DCC bridge mock frame. Connect the real plugin to capture live camera output.</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function nextWorkflowId() {
  return `wf-${crypto.randomUUID()}`;
}

function nextMessageId() {
  return `msg-${crypto.randomUUID()}`;
}

function probeTcp(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// 媒体代理纯工具函数已抽离至 lib/media-utils.mjs（inferMediaContentType / looksLikeHtml /
// sanitizeForwardHeaderValue / parseAwsSignedAt / getRemoteSignedUrlExpiry /
// createMediaProxyErrorPayload / normalizeHttpUrl / readHeaderValue），经顶部 import 复用，行为零变更。
// 以下依赖主文件运行时状态（send / extractFirstString）的函数仍保留在此。

function sendMediaProxyError(res, status, category, provider, message) {
  return send(
    res,
    status,
    createMediaProxyErrorPayload(status, category, provider, message),
    {
      'Cache-Control': 'no-store',
      'X-HMDAO-Media-Error': sanitizeForwardHeaderValue(category),
      ...(provider ? { 'X-HMDAO-Media-Provider': sanitizeForwardHeaderValue(provider) } : {}),
    },
  );
}

function detectRemoteMediaUpstreamIssue(targetUrl, upstream) {
  const signedUrl = getRemoteSignedUrlExpiry(targetUrl);
  if (signedUrl?.provider === 'siliconflow' && signedUrl.expired) {
    return {
      status: 410,
      category: 'remote-asset-expired',
      provider: 'siliconflow',
      message: 'SiliconFlow temporary asset URL has expired and must be regenerated or re-uploaded.',
    };
  }

  const contentType = readHeaderValue(upstream.headers, 'content-type').toLowerCase();
  const bodyText = upstream.body?.length
    ? upstream.body.toString('utf8').trim()
    : '';
  const looksJson = contentType.includes('application/json')
    || contentType.includes('+json')
    || bodyText.startsWith('{')
    || bodyText.startsWith('[');
  let payload = null;
  if (looksJson && bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = null;
    }
  }
  const message = String(
    payload?.message
    || payload?.error?.message
    || bodyText
    || `Remote media request failed with HTTP ${Number(upstream.status || 0)}.`,
  ).trim();

  if (
    (signedUrl?.provider === 'siliconflow' || signedUrl?.host?.includes('siliconflow.cn'))
    && (
      Number(payload?.code) === 60000
      || /token\s+has\s+invalid\s+claims/i.test(message)
      || /token\s+is\s+expired/i.test(message)
    )
  ) {
    return {
      status: 410,
      category: 'remote-asset-expired',
      provider: 'siliconflow',
      message: 'SiliconFlow temporary asset URL has expired and must be regenerated or re-uploaded.',
    };
  }

  if (Number(upstream.status || 0) >= 400 || looksJson) {
    return {
      status: Number(upstream.status || 502) >= 400 ? Number(upstream.status || 502) : 502,
      category: 'remote-media-fetch-failed',
      provider: signedUrl?.provider || '',
      message,
    };
  }

  if (looksLikeHtml(upstream.body, contentType)) {
    return {
      status: 422,
      category: 'remote-asset-not-media',
      provider: signedUrl?.provider || '',
      message:
        '上游返回的是网页(HTML)而不是音频/视频文件。通常是源站启用了防盗链、需要登录，或服务端请求未携带正确的来源页 Referer/登录态。请在浏览器中直接打开该素材地址确认，或改用带正确来源页的地址后再导入。',
    };
  }

  return null;
}

// P1-11：以下 5 个函数已抽取至 lib/http-fetch-utils.mjs。
import {
  downloadRemoteMediaBuffer,
  extensionFromMimeType,
  nativeHttpRequest,
  requestRemoteBinaryAsset,
} from './lib/http-fetch-utils.mjs';

// ———— yt-dlp 辅助函数 ————
// ★2026-08-18 修复：删除硬编码 C:\Users\123\yt-dlp.exe 兜底 —— 该路径遗留的是 PyInstaller onefile 旧版，
// 仍会触发"运行时自解压黑窗"问题（windowsHide:true 无法抑制 onefile 内置 bootloader 的弹窗）。
// 现仅保留「受信任位置」（全局 PATH），其他位置必须由「模型下载面板」一键安装到本机独立目录。
const YT_DLP_PATHS = [
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  'yt-dlp',
];
function resolveYtDlpPath() {
  // 优先使用「模型下载面板」一键安装的托管运行时（用户可在任意机器下载安装，已强制 onedir，无黑窗）。
  // ★2026-09-01 修复（/api/platform/ytdlp 与 /api/youtube/extract 恒 503 的真凶）：
  //   旧代码用 require('fs').accessSync(...) —— 本文件是 ESM(.mjs)，且顶层只 import 了
  //   `promises as fs`（注意：那是 fs.promises，**没有 accessSync**），也从未 createRequire
  //   → require 未定义 → 抛 ReferenceError → 被 catch(_){} 静默吞掉
  //   → 即使 yt-dlp.exe 已正确安装且可执行，本函数仍恒返回 null → 上层一律返回
  //     503 "yt-dlp 未安装或不可执行"（提示极具误导性，让人反复重装）。
  //   改用已 import 的 existsSync：Windows 下 X_OK 语义与"文件存在"一致，无需额外校验。
  const managed = detectManagedLocalPostYtDlpPath();
  if (managed) {
    try { if (existsSync(managed)) return managed; } catch (_) {}
  }
  for (const p of YT_DLP_PATHS) {
    try { if (existsSync(p)) return p; } catch (_) {}
  }
  return null; // 找不到就返回 null，让上层 spawn 报错走「安装 yt-dlp」提示
}
function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function proxyRemoteMediaAsset(req, res, mediaUrl, kind = '', referer = '', origin = '') {
  const targetUrl = String(mediaUrl || '').trim();
  const isHttpTarget = /^https?:\/\//i.test(targetUrl);
  const isFileUrlTarget = /^file:\/\//i.test(targetUrl);
  const isWindowsPathTarget = /^[a-zA-Z]:[\\/]/.test(targetUrl) || targetUrl.startsWith('\\\\');
  if (!isHttpTarget && !isFileUrlTarget && !isWindowsPathTarget) {
    return send(res, 400, { success: false, error: { message: 'Media proxy requires an absolute http(s) URL or local file path.' } });
  }

  // 同源本地预览资源（如 http://127.0.0.1:3000/assets/...）：直接读取对应静态文件返回，
  // 不再经 media-proxy「自请求」本机 URL。否则文件缺失时 static 服务兜底返回
  // index.html（HTML），被 detectRemoteMediaUpstreamIssue 误判为 422（Unprocessable Entity）。
  if (isHttpTarget) {
    const webPort = String(process.env.HMDAO_APP_PORT || '3000');
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      parsed = null;
    }
    if (
      parsed
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
      && parsed.port === webPort
      && parsed.pathname.startsWith('/assets/')
    ) {
      const webDistDir = path.resolve(APP_DIR, 'dist');
      const filePath = path.normalize(path.join(webDistDir, parsed.pathname));
      if (filePath.startsWith(webDistDir)) {
        try {
          await sendLocalFileStream(req, res, filePath, {
            mimeType: mediaMimeTypeFromExtension(filePath, inferMediaContentType(filePath, '', kind)),
            contentDisposition: buildSafeInlineContentDisposition(filePath),
          });
          return;
        } catch {
          return send(res, 404, { success: false, error: { message: 'local-asset-not-found' } });
        }
      }
    }
  }

  if (isFileUrlTarget || isWindowsPathTarget) {
    let filePath = targetUrl;
    if (isFileUrlTarget) {
      try {
        filePath = fileURLToPath(targetUrl);
      } catch {
        filePath = decodeURIComponent(targetUrl.replace(/^file:\/\/\/?/i, ''));
      }
    }
    const resolvedPath = path.resolve(String(filePath || '').trim());
    if (!resolvedPath) {
      return send(res, 400, { success: false, error: { message: 'invalid-local-media-path' } });
    }
    try {
      await sendLocalFileStream(req, res, resolvedPath, {
        mimeType: mediaMimeTypeFromExtension(resolvedPath, inferMediaContentType(resolvedPath, '', kind)),
        contentDisposition: buildSafeInlineContentDisposition(resolvedPath),
      });
      return;
    } catch (error) {
      return send(res, 404, {
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'local-media-not-found',
        },
      });
    }
  }
  const signedUrl = getRemoteSignedUrlExpiry(targetUrl);
  if (signedUrl?.provider === 'siliconflow' && signedUrl.expired) {
    return sendMediaProxyError(
      res,
      410,
      'remote-asset-expired',
      'siliconflow',
      'SiliconFlow temporary asset URL has expired and must be regenerated or re-uploaded.',
    );
  }

  const upstreamHeaders = {
    Accept: req.headers.accept || '*/*',
    'User-Agent': req.headers['user-agent'] || 'HMDao-MediaProxy/1.0',
  };
  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }
  // 转发来源页 Referer/Origin，以绕过仅依赖 Referer 的防盗链（源站常只对带正确
  // Referer 的请求返回真实媒体，否则返回登录/播放器 HTML 页面）。
  if (referer) {
    upstreamHeaders.Referer = sanitizeForwardHeaderValue(referer);
    if (!origin) upstreamHeaders.Origin = sanitizeForwardHeaderValue(referer);
  }
  if (origin) upstreamHeaders.Origin = sanitizeForwardHeaderValue(origin);

  try {
    const upstream = await requestRemoteBinaryAsset(targetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      timeoutMs: 45000,
    });
    const upstreamIssue = detectRemoteMediaUpstreamIssue(targetUrl, upstream);
    if (upstreamIssue) {
      return sendMediaProxyError(
        res,
        upstreamIssue.status,
        upstreamIssue.category,
        upstreamIssue.provider,
        upstreamIssue.message,
      );
    }
    const body = upstream.body;
    const contentType = inferMediaContentType(targetUrl, readHeaderValue(upstream.headers, 'content-type'), kind);
    const contentDisposition = sanitizeForwardHeaderValue(readHeaderValue(upstream.headers, 'content-disposition'));
    const contentLengthHeader = readHeaderValue(upstream.headers, 'content-length');
    const responseContentLength = req.method === 'HEAD'
      ? String(Number(contentLengthHeader || 0))
      : String(body.length);
    const headers = {
      'Content-Type': contentType,
      'Content-Length': responseContentLength,
      'Cache-Control': 'private, max-age=300',
      'Accept-Ranges': readHeaderValue(upstream.headers, 'accept-ranges') || 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // CORS 由 sendRaw() 统一处理，不再硬编码 *
      ...(readHeaderValue(upstream.headers, 'content-range') ? { 'Content-Range': readHeaderValue(upstream.headers, 'content-range') } : {}),
      ...(readHeaderValue(upstream.headers, 'etag') ? { ETag: readHeaderValue(upstream.headers, 'etag') } : {}),
      ...(readHeaderValue(upstream.headers, 'last-modified') ? { 'Last-Modified': readHeaderValue(upstream.headers, 'last-modified') } : {}),
      ...(contentDisposition ? { 'Content-Disposition': contentDisposition.replace(/attachment/ig, 'inline') } : {}),
    };
    return sendRaw(res, upstream.status, body, headers);
  } catch (error) {
    return send(res, 502, {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * 后端 Hugging Face Hub 代理（用于本地 NLLB 翻译模型下载）
 *
 * 浏览器端 Transformers.js 从 huggingface.co 下载 ~600MB 模型文件，
 * 在当前网络环境下该域名对 Node 进程不可达（连接超时），而镜像源
 * hf-mirror.com 可由 Node 直连。此路由将请求经后端转发到镜像源
 * （huggingface.co 作为兜底），绕开浏览器直连限制。
 *
 * 路由：GET/HEAD /api/hf-proxy/{model}/resolve/{revision}/{path...}
 * 转发：https://hf-mirror.com/{model}/resolve/{revision}/{path...}
 * 采用流式转发，避免把 600MB 模型整体缓冲进内存。
 */
// P1b：后台把模型文件预热到服务端磁盘缓存（绕开美国 CDN 慢链路）。
// 浏览器「一键安装」时前端会 POST /api/hf-proxy/prefetch/{model}，触发后服务端慢慢从镜像拉取落盘，
// 浏览器随后的真实 GET 即可从同源磁盘命中，首装与重试耗时大幅缩短。
async function prewarmHfModel(modelKey) {
  const files = HF_PROXY_PREWARM[modelKey];
  if (!files || !files.length) return;
  const cacheDir = ensureHfProxyCacheDir();
  const hosts = ['https://hf-mirror.com', 'https://huggingface.co'];
  const hfToken = process.env.HF_TOKEN;
  for (const file of files) {
    const suffix = `${modelKey}/resolve/main/${file}`;
    const cacheKey = crypto.createHash('sha1').update(suffix).digest('hex');
    const cacheFile = path.join(cacheDir, cacheKey);
    const cacheTmp = `${cacheFile}.part`;
    if (existsSync(cacheFile) || hfProxyCacheLocks.has(cacheKey)) continue;
    hfProxyCacheLocks.add(cacheKey);
    let ws = null;
    try { ws = createWriteStream(cacheTmp); } catch { hfProxyCacheLocks.delete(cacheKey); continue; }
    let ok = false;
    for (const host of hosts) {
      const target = `${host}/${suffix}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('hf-proxy-timeout')), 30 * 60 * 1000);
      try {
        const upstream = await fetch(target, {
          method: 'GET',
          headers: {
            'User-Agent': 'HMDao-HFProxy/1.0',
            'Accept-Encoding': 'identity',
            ...(hfToken ? { Authorization: `Bearer ${hfToken}` } : {}),
          },
          redirect: 'follow',
          signal: controller.signal,
        });
        if (!upstream.ok || upstream.status === 404) { try { upstream.body?.cancel?.(); } catch { /* noop */ } continue; }
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
          }
        }
        ok = true;
        break;
      } catch {
        try { upstream?.body?.cancel?.(); } catch { /* noop */ }
        continue;
      } finally {
        clearTimeout(timeout);
      }
    }
    try { await new Promise((r) => ws.end(r)); } catch { /* noop */ }
    hfProxyCacheLocks.delete(cacheKey);
    try {
      if (ok) await fs.rename(cacheTmp, cacheFile);
      else await fs.unlink(cacheTmp);
    } catch { /* noop */ }
  }
}

async function proxyHuggingFace(req, res, url) {
  const prefix = '/api/hf-proxy/';
  const suffix = String(url.pathname || '').startsWith(prefix)
    ? String(url.pathname || '').slice(prefix.length)
    : '';
  if (!suffix || suffix.includes('..') || suffix.startsWith('/')) {
    return send(res, 400, { success: false, error: { message: 'invalid-hf-proxy-path' } });
  }

  // P1b：POST /api/hf-proxy/prefetch/{model} → 后台预热模型文件到服务端磁盘缓存（非阻塞）
  if (req.method === 'POST' && suffix.startsWith('prefetch/')) {
    const modelKey = suffix.slice('prefetch/'.length);
    prewarmHfModel(modelKey).catch((e) => console.error('[hf-proxy] prefetch 失败', modelKey, e?.message));
    return send(res, 202, { success: true, message: 'prefetch-started', model: modelKey });
  }

  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
    : {};

  // ---- P1：服务端磁盘缓存命中 ----
  // 命中则直接从磁盘返回（同源、带正确 Content-Length），浏览器重试/弱网下秒取，
  // 同时规避「浏览器 IndexedDB 缓存损坏(offset out of bounds)」后仍需穿越美国 CDN 的问题。
  const isRangeRequest = Boolean(req.headers.range);
  const hfCacheKey = crypto.createHash('sha1').update(suffix).digest('hex');
  const hfCacheDir = ensureHfProxyCacheDir();
  const hfCacheFile = path.join(hfCacheDir, hfCacheKey);
  const hfCacheTmp = `${hfCacheFile}.part`;
  if (!isRangeRequest && existsSync(hfCacheFile)) {
    try {
      const st = await fs.stat(hfCacheFile);
      if (st.size > 0) {
        const diskHdrs = {
          ...corsHeaders,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(st.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Type',
        };
        res.writeHead(200, diskHdrs);
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(hfCacheFile).pipe(res);
        return;
      }
    } catch {
      /* 落盘读取失败，回退到上游拉取 */
    }
  }

  const upstreamHeaders = {
    Accept: req.headers.accept || '*/*',
    'User-Agent': req.headers['user-agent'] || 'HMDao-HFProxy/1.0',
    // 关键：强制上游不压缩，避免 Node fetch 自动解压后 Content-Length（压缩长度）
    // 与真实明文 body 不一致，导致浏览器按压缩长度截断模型文件 → offset is out of bounds。
    'Accept-Encoding': 'identity',
  };
  // 受限（gated）模型（如 briaai/RMBG-2.0）需要鉴权才能下载：若服务端配置了 HF_TOKEN，
  // 则携带 Bearer 令牌转发，使「需登录/接受许可」的模型也能经由本代理下载。
  const hfToken = process.env.HF_TOKEN;
  if (hfToken) {
    upstreamHeaders['Authorization'] = `Bearer ${hfToken}`;
  }
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;

  // 镜像源优先（Node 可直连），huggingface.co 兜底
  const hosts = ['https://hf-mirror.com', 'https://huggingface.co'];
  let lastError = null;

  for (const host of hosts) {
    const target = `${host}/${suffix}${url.search || ''}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('hf-proxy-timeout')), 30 * 60 * 1000);
    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
        signal: controller.signal,
      });

      if (upstream.status === 404) {
        // 文件在两个源都一致不存在，直接返回 404，便于前端准确报错
        try { upstream.body?.cancel?.(); } catch { /* noop */ }
        const fh = { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        res.writeHead(404, fh);
        res.end(JSON.stringify({ success: false, error: { message: 'model-file-not-found', path: suffix } }));
        return;
      }
      if (!upstream.ok && upstream.status !== 206) {
        // 其它非 2xx，尝试下一个源
        try { upstream.body?.cancel?.(); } catch { /* noop */ }
        lastError = new Error(`upstream ${upstream.status} from ${host}`);
        continue;
      }

      // Node fetch 默认自动解压响应体；若上游仍返回压缩内容（兜底场景），
      // 透传的 Content-Encoding/Content-Length 是「压缩后」口径，而本转发 body 已是解压明文，
      // 直接透传 Content-Length 会让浏览器按压缩长度截断 → 模型二进制损坏。
      // 因此：压缩响应不转发 Content-Length（改 chunked 真实长度）；未压缩才透传。
      const upstreamEncoding = upstream.headers.get('content-encoding');
      const isCompressed =
        !!upstreamEncoding && !/identity/i.test(upstreamEncoding);
      const forwardHeaders = {
        ...corsHeaders,
        'Access-Control-Allow-Headers': 'content-type, authorization, range',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified',
        'Cache-Control': 'public, max-age=3600',
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      };
      const contentLength = upstream.headers.get('content-length');
      if (!isCompressed && contentLength) forwardHeaders['Content-Length'] = contentLength;
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) forwardHeaders['Content-Range'] = contentRange;
      const etag = upstream.headers.get('etag');
      if (etag) forwardHeaders['ETag'] = etag;
      const lastModified = upstream.headers.get('last-modified');
      if (lastModified) forwardHeaders['Last-Modified'] = lastModified;

      res.writeHead(upstream.status, forwardHeaders);

      if (req.method === 'HEAD' || upstream.status === 204 || !upstream.body) {
        res.end();
        return;
      }

      // 全量 GET 成功时，把字节同时落到服务端磁盘缓存（供后续重试/弱网秒取）。
      // 已在缓存中或正被并发写入的文件跳过，避免多请求写入同一临时文件损坏。
      const shouldCache =
        !isRangeRequest && !existsSync(hfCacheFile) && !hfProxyCacheLocks.has(hfCacheKey);
      let cacheWs = null;
      if (shouldCache) {
        hfProxyCacheLocks.add(hfCacheKey);
        try { cacheWs = createWriteStream(hfCacheTmp); } catch { cacheWs = null; }
      }

      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            if (!res.write(Buffer.from(value))) {
              await new Promise((resolve) => res.once('drain', resolve));
            }
            if (cacheWs) {
              if (!cacheWs.write(Buffer.from(value))) {
                await new Promise((resolve) => cacheWs.once('drain', resolve));
              }
            }
          }
        }
        await new Promise((resolve) => res.end(resolve));
        if (cacheWs) {
          await new Promise((resolve) => cacheWs.end(resolve));
          try { await fs.rename(hfCacheTmp, hfCacheFile); } catch { try { await fs.unlink(hfCacheTmp); } catch {} }
        }
        return;
      } catch (streamErr) {
        try { await fs.unlink(hfCacheTmp); } catch {}
        throw streamErr;
      } finally {
        if (cacheWs) hfProxyCacheLocks.delete(hfCacheKey);
      }
    } catch (error) {
      lastError = error;
      continue;
    } finally {
      clearTimeout(timeout);
      try { upstream?.body?.cancel?.(); } catch { /* noop */ }
    }
  }

  // 所有源都失败
  if (!res.headersSent) {
    return send(res, 502, {
      success: false,
      error: {
        message: `hf-proxy-failed: ${lastError instanceof Error ? lastError.message : String(lastError || 'all-upstreams-failed')}`,
      },
    });
  }
  // 已写出响应头，优雅关闭
  try { res.end(); } catch { /* noop */ }
}

/**
 * 路由：GET/HEAD /api/local-model/{id}  与  POST /api/local-model/prefetch/{id}
 *
 * 背景：HuggingFace 新版 Xet 存储会把大文件二进制 302 重定向到美国 AWS S3 CDN
 * （cas-bridge.xethub.hf.co），即便走 hf-mirror 也只代理「文件在哪」的元数据，真实字节
 * 仍来自美国，导致国内浏览器拉取 BiRefNet 等大模型极慢、进度条几乎不动、且每次重试都从
 * 美国重下。
 *
 * 方案：后端把模型一次性拉到本机磁盘缓存（tmp/model-cache/{id}.onnx），之后浏览器从
 * 127.0.0.1 本地秒下。首次请求（尚未缓存）时边从上游拉取边写入磁盘（tee）并透传
 * Content-Length，使进度条可正常推进；后续请求直接本地读盘，极快。
 * POST prefetch 触发后台预拉取（非阻塞），便于先让服务端慢速拉完、浏览器再来秒取。
 */
const LOCAL_MODEL_SOURCES = {
  // 2026-07-20 状态：BiRefNet 的 int8 量化在本机无法产出可用模型，故该引擎暂时禁用，抠像走 @imgly 兜底。
  // 根因（已验证）：
  //  - 静态量化 quantize_static(QDQ/QOperator) 在本机 ORT 1.27 下对该 927MB 模型确定性卡死
  //    （~1000s CPU 后进程挂起，反复验证），无法生成小体积 int8 模型；
  //  - 动态量化会产出 1GB 坏模型（原 fp32 权重未移除 + 叠加 int8 路径，且无 DequantizeLinear 桥接），
  //    浏览器加载时需分配整文件大小(1GB)的连续 wasm 缓冲 → 失败；
  //  - HuggingFace 的 onnx-community/BiRefNet-ONNX 只提供 fp32/fp16，无现成 int8 可下载。
  // 因此指向一个不存在的路径，使后端干净返回模型缺失 → 前端直接回退 @imgly/background-removal
  // （isnet_quint8，小巧、浏览器原生支持，已验证可用）。磁盘上的 birefnet_uint8.onnx / model.onnx
  // 保留不删，待在更强机器上量化出真正的小 int8 后可改回此处启用。
  'birefnet-matting': 'f:/Work/HMDAODAO/app/tmp/model-cache/birefnet_uint8.onnx.DISABLED',
};
const MODEL_CACHE_DIR = path.join(process.cwd(), 'tmp', 'model-cache');
let modelCacheReady = false;
function ensureModelCacheDir() {
  if (modelCacheReady) return;
  try { mkdirSync(MODEL_CACHE_DIR, { recursive: true }); } catch { /* noop */ }
  modelCacheReady = true;
}
// 本地已量化文件源（绝对路径 / file://），识别后直接服务，不再去上游拉取。
function isLocalModelSource(src) {
  if (typeof src !== 'string' || !src) return false;
  if (src.startsWith('file://')) return true;
  // Windows 绝对路径如 f:\... 或 f:/...
  return /^[a-zA-Z]:[\\/]/.test(src);
}
function localModelPathFromSource(src) {
  return path.resolve(src.startsWith('file://') ? src.slice('file://'.length) : src);
}
// 缓存文件名按模型源区分：本地源直接用源文件本身；URL 源用 basename（避免 fp16/fp32 串味）。
function localModelFileFor(id) {
  const src = LOCAL_MODEL_SOURCES[id];
  if (src && isLocalModelSource(src)) return localModelPathFromSource(src);
  const base = src ? src.split('/').pop() || `${id}.onnx` : `${id}.onnx`;
  return path.join(MODEL_CACHE_DIR, base);
}
const modelPrefetching = new Set();

async function streamUpstreamToDisk(id, localPath, tmpPath) {
  const src = LOCAL_MODEL_SOURCES[id];
  if (!src) throw new Error('unknown-local-model:' + id);
  if (isLocalModelSource(src)) throw new Error('local-source-should-not-stream:' + id);
  const upstreams = [src, src.replace('hf-mirror.com', 'huggingface.co')];
  let lastErr;
  for (const u of upstreams) {
    try {
      const upstream = await fetch(u, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' },
      });
      if (!upstream.ok || !upstream.body) { lastErr = new Error('upstream ' + upstream.status); continue; }
      const ws = createWriteStream(tmpPath);
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
        }
      }
      await new Promise((r) => ws.end(r));
      await fs.rename(tmpPath, localPath);
      console.info(`[local-model] 已缓存 ${id} -> ${localPath}`);
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('download-failed');
}

async function downloadModelToDisk(id) {
  if (modelPrefetching.has(id)) return;
  modelPrefetching.add(id);
  try {
    ensureModelCacheDir();
    const localPath = localModelFileFor(id);
    // 本地已量化文件（绝对路径源）直接存在，无需下载；缺失则报错避免误走上游。
    if (isLocalModelSource(LOCAL_MODEL_SOURCES[id])) {
      if (existsSync(localPath)) return;
      throw new Error('local-model-missing:' + id + ' @ ' + localPath);
    }
    if (existsSync(localPath)) return;
    await streamUpstreamToDisk(id, localPath, localPath + '.part');
  } finally {
    modelPrefetching.delete(id);
  }
}

async function serveLocalModel(req, res, url) {
  const prefix = '/api/local-model/';
  const rest = String(url.pathname || '').slice(prefix.length);

  // 后台预拉取：触发即返回 202，由服务端慢慢从美国拉到本地磁盘
  if (req.method === 'POST' && rest.startsWith('prefetch/')) {
    const id = rest.slice('prefetch/'.length);
    if (!LOCAL_MODEL_SOURCES[id]) return send(res, 404, { success: false, error: 'unknown-model' });
    downloadModelToDisk(id).catch((e) => console.error('[local-model] prefetch 失败', id, e?.message));
    return send(res, 202, { success: true, message: 'prefetch-started', id });
  }

  const id = rest;
  if (!LOCAL_MODEL_SOURCES[id]) return send(res, 404, { success: false, error: 'unknown-model' });
  ensureModelCacheDir();
  const localPath = localModelFileFor(id);

  // 已缓存：本地读盘，极快，带 Content-Length 让进度条正常
  if (existsSync(localPath)) {
    try {
      const stat = await fs.stat(localPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Content-Disposition': `inline; filename="${id}.onnx"`,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': resolveCorsOrigin(req.headers.origin || ''),
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(localPath).pipe(res);
      return;
    } catch { /* 落到上游 */ }
  }

  // 未缓存：从上游拉取并 tee 到磁盘（首次较慢，之后走本地）
  const src = LOCAL_MODEL_SOURCES[id];
  const upstreams = [src, src.replace('hf-mirror.com', 'huggingface.co')];
  let lastErr;
  for (const u of upstreams) {
    try {
      const upstream = await fetch(u, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' },
      });
      if (!upstream.ok) { lastErr = new Error('upstream ' + upstream.status); continue; }
      const passHeaders = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) passHeaders[h] = v;
      }
      passHeaders['Access-Control-Allow-Origin'] = resolveCorsOrigin(req.headers.origin || '');
      passHeaders['Content-Disposition'] = `inline; filename="${id}.onnx"`;
      res.writeHead(upstream.status, passHeaders);
      if (req.method === 'HEAD' || !upstream.body) { res.end(); return; }
      const tmpPath = localPath + '.dl';
      const ws = createWriteStream(tmpPath);
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
          if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
        }
      }
      ws.end();
      await new Promise((r) => ws.once('finish', r));
      try { await fs.rename(tmpPath, localPath); } catch { /* 可能已被 prefetch 写入，忽略 */ }
      res.end();
      return;
    } catch (e) { lastErr = e; }
  }
  if (!res.headersSent) {
    return send(res, 502, { success: false, error: 'local-model-failed: ' + (lastErr instanceof Error ? lastErr.message : 'all-upstreams-failed') });
  }
  try { res.end(); } catch { /* noop */ }
}

/**
 * 路由：GET/HEAD /api/transformers/{file}
 * 同源提供 @xenova/transformers 的浏览器预构建包（含 onnxruntime-web 的 wasm），
 * 使本地翻译模型在无法访问外国 CDN（jsdelivr / cloudflare）的网络环境下也能加载。
 * 该目录同时包含 transformers.min.js 与各 ort-wasm-*.wasm，因此代码与 wasm 同源提供。
 */
async function serveTransformersModule(req, res, url) {
  const prefix = '/api/transformers/';
  if (!String(url.pathname || '').startsWith(prefix)) return false;
  const rel = decodeURIComponent(String(url.pathname || '').slice(prefix.length));
  if (
    !rel ||
    rel.includes('..') ||
    rel.startsWith('/') ||
    rel.includes('\\') ||
    rel.includes('\0')
  ) {
    send(res, 400, { success: false, error: { message: 'invalid-transformers-path' } });
    return true;
  }

  const baseDir = path.resolve(APP_DIR, 'node_modules/@xenova/transformers/dist');
  const filePath = path.resolve(baseDir, rel);
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    send(res, 400, { success: false, error: { message: 'invalid-transformers-path' } });
    return true;
  }

  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) {
      send(res, 404, { success: false, error: { message: 'transformers-file-not-found' } });
      return true;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.wasm' ? 'application/wasm'
      : ext === '.js' || ext === '.mjs' ? 'application/javascript'
      : ext === '.map' ? 'application/json'
      : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': resolveCorsOrigin(req.headers.origin || ''),
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      try { res.destroy(); } catch { /* noop */ }
    });
    stream.pipe(res);
    return true;
  } catch {
    send(res, 404, { success: false, error: { message: 'transformers-file-not-found' } });
    return true;
  }
}

// P1-11：以下 15 个函数已抽取至 lib/image-analysis-utils.mjs。
import {
  buildImageAnalysisRemotePrompt,
  buildImageDataUrl,
  getConfiguredImageAnalysisCommands,
  getConfiguredImageAnalysisRuntimes,
  inferImageAnalysisFallback,
  mergeImageAnalysisResults,
  modelLabelForRuntime,
  normalizeImageAnalysisResult,
  probeAnalyzeImageFile,
} from './lib/image-analysis-utils.mjs';

function resolveImageAnalysisRuntime(requestedEngine = 'auto', preferred = null) {
  const requested = String(requestedEngine || 'auto').trim().toLowerCase() || 'auto';
  const commands = getConfiguredImageAnalysisCommands();
  const configuredRuntimes = getConfiguredImageAnalysisRuntimes();
  const activatedCloudImageAnalysis = pickActivatedCloudImageAnalysisRuntime();
  // 用户显式选择的 provider 若已激活（严格匹配）且未配置本地 custom-api 命令时，优先走该云端模型（模型选择生效）；
  // 未激活则不强制远程，保持免 Key 本地链路（可预期、忠实于用户所选）。
  const preferredProvider = preferred && String(preferred.provider || '').trim().toLowerCase();
  if (preferredProvider && !String(commands.customApi || '').trim()) {
    const preferredCloud = pickActivatedCloudImageAnalysisRuntime(preferred);
    if (preferredCloud && String(preferredCloud.provider || '').trim().toLowerCase() === preferredProvider) {
      // 用户在前端显式选择的模型优先（让面板选中的具体视觉模型真正生效），否则用激活记录中的模型
      const resolvedModel = String(preferred?.model || '').trim() || String(preferredCloud.model || '').trim();
      return {
        requested,
        resolved: 'custom-api',
        commandLine: '',
        chain: ['custom-api'],
        mode: 'remote',
        remoteProvider: String(preferredCloud.provider || '').trim(),
        remoteModel: resolvedModel,
        remoteEndpoint: String(preferredCloud.endpoint || '').trim(),
        remoteApiKey: String(preferredCloud.apiKey || '').trim(),
      };
    }
  }
  const preferredQwenCommand = String(commands.qwen35vl || commands.qwen25vl || commands.genericCommand || '').trim();
  const preferredQwenResolved = commands.qwen35vl
    ? 'qwen35-vl'
    : commands.qwen25vl
      ? 'qwen25-vl'
      : 'local-heuristic';
  const fusionChain = configuredRuntimes
    .filter((item) => ['clip-interrogator', 'qwen35-vl', 'florence2', 'custom-api'].includes(item.id))
    .map((item) => item.id);
  const freeVision = nextFreeLlm('vision');
  const autoPreferred = freeVision
    ? {
        resolved: 'custom-api',
        commandLine: '',
        chain: ['custom-api'],
        mode: 'remote',
        remoteProvider: String(freeVision.provider || '').trim(),
        remoteModel: String(freeVision.model || '').trim(),
        remoteEndpoint: String(freeVision.endpoint || '').trim(),
        remoteApiKey: String(freeVision.apiKey || '').trim(),
      }
    : (fusionChain.length >= 2
      ? {
          envCommand: '__HMDAO_PROMPT_FUSION__',
          resolved: 'prompt-fusion',
          chain: fusionChain,
          mode: 'fusion',
        }
      : configuredRuntimes[0]
        ? {
            envCommand: configuredRuntimes[0].commandLine,
            resolved: configuredRuntimes[0].id,
            chain: [configuredRuntimes[0].id],
            mode: 'single',
          }
        : {
            envCommand: '',
            resolved: 'local-heuristic',
            chain: [],
            mode: 'fallback',
          });
  const engineConfig = {
    auto: autoPreferred,
    'local-heuristic': {
      envCommand: '',
      resolved: 'local-heuristic',
      chain: [],
      mode: 'fallback',
    },
    'prompt-fusion': {
      envCommand: fusionChain.length > 0 ? '__HMDAO_PROMPT_FUSION__' : '',
      resolved: fusionChain.length > 0 ? 'prompt-fusion' : 'local-heuristic',
      chain: fusionChain,
      mode: fusionChain.length > 0 ? 'fusion' : 'fallback',
    },
    'clip-interrogator': {
      envCommand: commands.clipInterrogator || commands.genericCommand,
      resolved: 'clip-interrogator',
      chain: commands.clipInterrogator || commands.genericCommand ? ['clip-interrogator'] : [],
      mode: commands.clipInterrogator || commands.genericCommand ? 'single' : 'fallback',
    },
    florence2: {
      envCommand: commands.florence2 || commands.genericCommand,
      resolved: 'florence2',
      chain: commands.florence2 || commands.genericCommand ? ['florence2'] : [],
      mode: commands.florence2 || commands.genericCommand ? 'single' : 'fallback',
    },
    'qwen25-vl': {
      envCommand: preferredQwenCommand,
      resolved: preferredQwenResolved,
      chain: preferredQwenCommand ? [preferredQwenResolved] : [],
      mode: preferredQwenCommand ? 'single' : 'fallback',
    },
    'qwen35-vl': {
      envCommand: preferredQwenCommand,
      resolved: preferredQwenResolved,
      chain: preferredQwenCommand ? [preferredQwenResolved] : [],
      mode: preferredQwenCommand ? 'single' : 'fallback',
    },
    'qwen37-vl': {
      envCommand: preferredQwenCommand,
      resolved: preferredQwenCommand ? 'qwen37-vl' : 'local-heuristic',
      chain: preferredQwenCommand ? ['qwen37-vl'] : [],
      mode: preferredQwenCommand ? 'single' : 'fallback',
    },
    'custom-api': {
      envCommand: commands.customApi,
      resolved: 'custom-api',
      chain: commands.customApi
        ? ['custom-api']
        : activatedCloudImageAnalysis
          ? ['custom-api']
          : [],
      mode: commands.customApi
        ? 'single'
        : activatedCloudImageAnalysis
          ? 'remote'
          : 'fallback',
      remoteProvider: activatedCloudImageAnalysis?.provider || '',
      remoteModel: activatedCloudImageAnalysis?.model || '',
      remoteEndpoint: activatedCloudImageAnalysis?.endpoint || '',
      remoteApiKey: activatedCloudImageAnalysis?.apiKey || '',
    },
  };
  const selected = engineConfig[requested] || engineConfig.auto;
  return {
    requested,
    resolved: selected.resolved,
    commandLine: String(selected.envCommand || '').trim(),
    chain: Array.isArray(selected.chain) ? selected.chain : [],
    mode: String(selected.mode || (String(selected.envCommand || '').trim() ? 'single' : 'fallback')),
    remoteProvider: String(selected.remoteProvider || '').trim(),
    remoteModel: String(selected.remoteModel || '').trim(),
    remoteEndpoint: String(selected.remoteEndpoint || '').trim(),
    remoteApiKey: String(selected.remoteApiKey || '').trim(),
  };
}

function pickActivatedCloudImageAnalysisRuntime(preferred = null) {
  const rankedProviders = ['openai', 'siliconflow', 'bailian', 'modelscope', 'zhipu', 'volcengine', 'deepseek', 'minimax'];
  const candidates = listActivatedProviderRecords()
    .filter((record) => (
      // 只选 LLM 模式模型做分析；图像/视频生成模型（wanx/flux/seedance）不能用于图片分析
      String(record?.mode || '').trim().toLowerCase() === 'llm'
      && String(record?.apiKey || '').trim()
      && String(record?.model || '').trim()
      && String(record?.endpoint || PROVIDER_BASE_URLS[record?.provider] || '').trim()
    ))
    .sort((left, right) => {
      const leftProvider = rankedProviders.indexOf(String(left?.provider || '').trim());
      const rightProvider = rankedProviders.indexOf(String(right?.provider || '').trim());
      const leftRank = leftProvider === -1 ? rankedProviders.length : leftProvider;
      const rightRank = rightProvider === -1 ? rankedProviders.length : rightProvider;
      if (leftRank !== rightRank) return leftRank - rightRank;
      // 优先选择真正具备视觉理解能力的模型
      const leftVision = isVisionModelId(left?.model) ? 1 : 0;
      const rightVision = isVisionModelId(right?.model) ? 1 : 0;
      if (leftVision !== rightVision) return rightVision - leftVision;
      return Number(right?.activatedAt || 0) - Number(left?.activatedAt || 0);
    });
  // 用户在前端显式选择的 provider 优先；未匹配则回退到默认排序首位
  const preferredProvider = preferred && String(preferred.provider || '').trim().toLowerCase();
  const target = (preferredProvider
    ? candidates.find((record) => String(record?.provider || '').trim().toLowerCase() === preferredProvider)
    : null) || candidates[0];
  if (!target) return null;
  return {
    provider: String(target.provider || '').trim(),
    model: String(target.model || '').trim(),
    endpoint: String(target.endpoint || PROVIDER_BASE_URLS[target.provider] || '').trim().replace(/\/$/, ''),
    apiKey: String(target.apiKey || '').trim(),
    mode: 'llm',
  };
}

// ===== 免费额度 LLM 轮换（智能机器人聊天 + 图片/视频反推提示词共用"平台免费模型"）=====
// 聊天与图片分析都走"平台里免费额度的模型"，并在多个免费模型之间轮换，避免单模型限流/额度耗尽。
// TokenHub 内置免费文本/视觉模型池（走 HMDAO_AI_KEY，腾讯免费额度通道）。
const TOKENHUB_FREE_CHAT_MODELS = [
  'hy3', 'glm-5.2', 'qwen3.5-plus', 'deepseek-v4-flash',
  'minimax-m3', 'kimi-k2.7-code', 'qwen3.5-flash', 'hunyuan-t1-vision',
];
// 平台免费额度（腾讯 TokenHub）当前无可用视觉模型（hunyuan-t1-vision 不存在、glm-5.2 不收图），
// 故视觉候选池为空，图片分析 auto 走本地 Florence-2 看图 + 在线免费文本 LLM 结构化中文。
const TOKENHUB_FREE_VISION_MODELS = [];

const freeLlmRotation = { chat: 0, vision: 0, signature: '' };

function collectFreeLlmCandidates(kind = 'chat') {
  const candidates = [];
  const tokenhubKey = String(process.env.HMDAO_AI_KEY || 'sk-dAViKE9mAm0RqXdfc8nFYn4xAYyOlMjp0l0LcfnmgYdfUcni').trim();
  const tokenhubUrl = String(process.env.HMDAO_AI_URL || 'https://tokenhub.tencentmaas.com/v1/chat/completions').trim();
  if (tokenhubKey) {
    // 平台免费额度通道（腾讯 TokenHub）优先：聊天/视觉均走免费模型池并轮换，
    // 不混入用户自行添加的非平台第三方 provider（如 suanliai.top），保证"免费额度"语义干净。
    const pool = kind === 'vision' ? TOKENHUB_FREE_VISION_MODELS : TOKENHUB_FREE_CHAT_MODELS;
    for (const m of pool) {
      candidates.push({ provider: 'tokenhub', model: m, endpoint: tokenhubUrl, apiKey: tokenhubKey });
    }
  } else {
    // 无 TokenHub key 时回退到用户已激活的 LLM provider 记录（兼容旧行为）
    const activationPool = listActivatedProviderRecords()
      .filter((r) => String(r?.mode || '').trim().toLowerCase() === 'llm'
        && String(r?.apiKey || '').trim()
        && String(r?.model || '').trim())
      .map((r) => ({
        provider: String(r.provider || '').trim(),
        model: String(r.model || '').trim(),
        endpoint: String(r.endpoint || PROVIDER_BASE_URLS[r.provider] || '').trim().replace(/\/$/, ''),
        apiKey: String(r.apiKey || '').trim(),
      }));
    candidates.push(...activationPool);
  }
  if (kind === 'vision') {
    // 视觉模型严格白名单：仅保留人工确认的视觉模型，避免把纯 LLM（如 gemini-3-flash 经第三方）误当视觉
    const VISION_ALLOW = /hunyuan[-\w.]*vision|glm-?4v|glm[-\w.]*v|glm[-\w.]*v[-\w.]*plus|qwen[-\w]*vl|qwen3[-\w]*vl|gpt-4[o1]|gpt-4\.1|gemini[-\w]*(pro|flash)|claude|llava|moondream|minicpm-v|phi-?3[-\w]*vision|internvl|deepseek-vl|doubao[-\w.]*vision|abab.*v|kimi[-\w]*vl|step[-\w]*vision|step-?1[\w.]*v|ernie[-\w.]*vl|cogvlm|cogagent/i;
    return candidates.filter((c) => VISION_ALLOW.test(c.model));
  }
  return candidates;
}

// 在免费额度模型池间 round-robin；候选集合变化（用户改了 provider/key）时重置索引，避免越界。
function nextFreeLlm(kind = 'chat') {
  const pool = collectFreeLlmCandidates(kind);
  if (pool.length === 0) return null;
  const signature = kind + ':' + pool.map((c) => `${c.provider}/${c.model}`).join(',');
  if (freeLlmRotation.signature !== signature) {
    freeLlmRotation.chat = 0;
    freeLlmRotation.vision = 0;
    freeLlmRotation.signature = signature;
  }
  const idx = freeLlmRotation[kind] % pool.length;
  freeLlmRotation[kind] = (idx + 1) % pool.length;
  return { ...pool[idx] };
}

async function runRemoteImageAnalysis(runtime, normalizedPayload, fallback) {
  const endpoint = String(runtime?.remoteEndpoint || '').trim().replace(/\/$/, '');
  const model = String(runtime?.remoteModel || '').trim();
  const apiKey = String(runtime?.remoteApiKey || '').trim();
  if (!endpoint || !model || !apiKey) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        '自定义 API 未检测到可用的云端视觉模型，已回退到本地链路',
      ]).slice(0, 12),
    };
  }

  const imageUrl = normalizedPayload?.inputPath
    ? await buildImageDataUrl(normalizedPayload.inputPath, normalizedPayload.inputMimeType || 'image/jpeg')
    : String(normalizedPayload?.sourceUrl || '').trim();
  if (!imageUrl) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        '自定义 API 缺少可分析的图片输入，已回退到本地链路',
      ]).slice(0, 12),
    };
  }

  const userPrompt = buildImageAnalysisRemotePrompt(normalizedPayload);
  const isVideoContext = /video[-_]?shot/i.test(String(normalizedPayload?.name || '').trim())
    || userPrompt.includes('Video context hints');

  const requestBody = {
    model,
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: isVideoContext
          ? 'You are a video analysis expert. Analyze video keyframes with attention to subject continuity, camera language, lighting evolution, and scene progression. Return only valid JSON.'
          : 'You are a multimodal creative director. Return only valid JSON.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  };

  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const remoteMessage = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || `HTTP ${response.status}`;
      return {
        ...fallback,
        warnings: uniqueStrings([
          ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
          `自定义 API 调用失败，已回退到本地链路：${remoteMessage}`,
        ]).slice(0, 12),
        runtime: {
          ...(fallback?.runtime || {}),
          provider: String(runtime?.remoteProvider || '').trim(),
          model,
          endpoint,
        },
      };
    }

    const content = extractFirstString(data?.choices?.[0]?.message?.content)
      || extractFirstString(data?.choices?.[0]?.text)
      || extractFirstString(data?.output_text)
      || extractFirstString(data?.content)
      || extractFirstString(data?.text);
    const parsed = extractJsonObjectFromText(content);
    if (!parsed || typeof parsed !== 'object') {
      return {
        ...fallback,
        warnings: uniqueStrings([
          ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
          '自定义 API 返回了非结构化结果，已回退到本地链路',
        ]).slice(0, 12),
        runtime: {
          ...(fallback?.runtime || {}),
          provider: String(runtime?.remoteProvider || '').trim(),
          model,
          endpoint,
        },
      };
    }

    return normalizeImageAnalysisResult({
      ...parsed,
      warnings: uniqueStrings([
        ...(Array.isArray(parsed?.warnings) ? parsed.warnings : []),
        '已通过自定义 API 云端模型完成视觉反推',
      ]).slice(0, 8),
    }, {
      ...fallback,
      engine: `custom-api:${String(runtime?.remoteProvider || 'remote').trim()}/${model}`,
      runtime: {
        ...(fallback?.runtime || {}),
        wrapperConfigured: true,
        wrapperCommand: 'custom-api',
        requestedEngine: String(runtime?.requested || 'custom-api'),
        resolvedEngine: 'custom-api',
        provider: String(runtime?.remoteProvider || '').trim(),
        model,
        endpoint,
        modelLabel: modelLabelForRuntime({ mode: 'remote', resolvedEngine: 'custom-api', provider: String(runtime?.remoteProvider || '').trim(), model }),
      },
      metadata: {
        ...(fallback?.metadata || {}),
        requestedEngine: String(runtime?.requested || 'custom-api'),
        resolvedEngine: 'custom-api',
        provider: String(runtime?.remoteProvider || '').trim(),
        model,
        endpoint,
        modelLabel: modelLabelForRuntime({ mode: 'remote', resolvedEngine: 'custom-api', provider: String(runtime?.remoteProvider || '').trim(), model }),
      },
    });
  } catch (error) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        `自定义 API 调用异常，已回退到本地链路：${error instanceof Error ? error.message : String(error)}`,
      ]).slice(0, 12),
      runtime: {
        ...(fallback?.runtime || {}),
        provider: String(runtime?.remoteProvider || '').trim(),
        model,
        endpoint,
      },
    };
  }
}

async function runSingleImageAnalysisEngine(runtime, normalizedPayload, fallback, cleanupPaths = []) {
  if (!runtime?.commandLine) {
    return fallback;
  }
  const wrapperPayloadPath = path.join(
    LOCAL_IMAGE_ANALYSIS_DIR,
    `${String(normalizedPayload?.requestId || crypto.randomUUID())}-${String(runtime.resolved || 'analysis')}-payload.json`,
  );
  cleanupPaths.push(wrapperPayloadPath);
  let wrapperResult;
  try {
    wrapperResult = await runJsonWrapperCommand(runtime.commandLine, normalizedPayload, {
      cwd: APP_DIR,
      payloadPath: wrapperPayloadPath,
      env: {
        HMDAO_IMAGE_ANALYSIS_INPUT: String(normalizedPayload?.inputPath || ''),
        HMDAO_IMAGE_ANALYSIS_ENGINE: String(runtime.resolved || ''),
      },
    });
  } catch (engineErr) {
    // R2：视觉引擎崩溃（如 Florence-2 调用失败）时，不把整条请求变成 success:false，
    // 而是带 warning 回退到启发式分析，前端据此可见「分析失败但已用基础分析兜底」。
    const msg = String((engineErr && engineErr.message) || engineErr);
    console.warn(`[runSingleImageAnalysisEngine] 引擎 ${runtime.resolved} 调用失败，回退启发式：`, msg);
    const failed = { ...fallback };
    failed.warning = `视觉引擎(${runtime.resolved})调用失败，已回退到基础分析：${msg}`;
    failed.runtime = {
      ...(failed.runtime || {}),
      requestedEngine: runtime.requested,
      resolvedEngine: runtime.resolved,
      wrapperConfigured: true,
      wrapperCommand: runtime.commandLine ? runtime.resolved : '',
      engineError: msg,
    };
    failed.metadata = { ...(failed.metadata || {}), requestedEngine: runtime.requested, resolvedEngine: runtime.resolved };
    return failed;
  }
  return normalizeImageAnalysisResult(wrapperResult.parsed, {
    ...fallback,
    metadata: {
      ...(fallback?.metadata || {}),
      requestedEngine: runtime.requested,
      resolvedEngine: runtime.resolved,
    },
  });
}

async function runFusedImageAnalysis(runtime, normalizedPayload, fallback, cleanupPaths = []) {
  const chain = Array.isArray(runtime?.chain) ? runtime.chain : [];
  const results = [];
  const warnings = [];
  for (const engineId of chain) {
    const engineRuntime = resolveImageAnalysisRuntime(engineId);
    if (!engineRuntime.commandLine) continue;
    try {
      const result = await runSingleImageAnalysisEngine(
        {
          ...engineRuntime,
          requested: runtime?.requested || engineRuntime.requested,
        },
        {
          ...normalizedPayload,
          engine: engineId,
        },
        fallback,
        cleanupPaths,
      );
      results.push(result);
    } catch (error) {
      warnings.push(`${engineId} wrapper failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!results.length) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        ...warnings,
        '提示词融合链未拿到有效结果，已回退到本地启发式分析',
      ]).slice(0, 12),
      runtime: {
        ...(fallback?.runtime || {}),
        wrapperConfigured: false,
        fusionEngines: chain,
      },
      metadata: {
        ...(fallback?.metadata || {}),
        fusionEngines: chain,
      },
    };
  }

  const merged = mergeImageAnalysisResults(fallback, results, runtime);
  merged.warnings = uniqueStrings([
    ...(Array.isArray(merged?.warnings) ? merged.warnings : []),
    ...warnings,
  ]).slice(0, 12);
  return merged;
}

async function processLocalImageAnalyzeRequest(payload, userId) {
  await fs.mkdir(LOCAL_IMAGE_ANALYSIS_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const cleanupPaths = Array.isArray(payload?.cleanupPaths) ? [...payload.cleanupPaths] : [];
  let inputPath = String(payload?.inputPath || '').trim();
  let inputMimeType = String(payload?.inputMimeType || '').trim() || 'image/jpeg';
  let width = Math.max(0, Number(payload?.width || 0));
  let height = Math.max(0, Number(payload?.height || 0));

  try {
    const sourceUrl = String(payload?.sourceUrl || '').trim();
    if (!inputPath && /^https?:\/\//i.test(sourceUrl)) {
      const remote = await downloadRemoteMediaBuffer(sourceUrl);
      inputMimeType = remote.mimeType || inputMimeType;
      const ext = imageExtensionFromMimeType(inputMimeType);
      inputPath = path.join(LOCAL_IMAGE_ANALYSIS_DIR, `${requestId}-remote.${ext}`);
      cleanupPaths.push(inputPath);
      await fs.writeFile(inputPath, remote.bytes);
    }

    // P0.1 修复：支持前端发来的相对路径（/api/assets/content/<id>）或显式 itemId，
    // 从本地资产库解析出真实文件路径取字节。否则相对路径不匹配远程正则 → 无字节 → 空壳分析。
    if (!inputPath) {
      const assetId = String(payload?.itemId || '').trim()
        || (sourceUrl.startsWith('/api/assets/content/')
          ? sanitizeLocalAssetId(sourceUrl.slice('/api/assets/content/'.length).split(/[?#]/, 1)[0])
          : '');
      if (assetId) {
        const catalog = await readAssetLibraryCatalog(userId).catch(() => []);
        const assetItem = Array.isArray(catalog)
          ? catalog.find((it) => String(it.id) === assetId)
          : null;
        if (assetItem && assetItem.filePath && (await fileExists(assetItem.filePath))) {
          inputPath = assetItem.filePath;
          if (assetItem.mimeType) inputMimeType = assetItem.mimeType;
          else if (assetItem.type && assetItem.type.startsWith('image/')) inputMimeType = assetItem.type;
        }
      }
    }

    if (inputPath && (!width || !height)) {
      const probed = await probeAnalyzeImageFile(inputPath).catch(() => ({ width: 0, height: 0 }));
      width = width || probed.width;
      height = height || probed.height;
    }

    const normalizedPayload = {
      ...payload,
      requestId,
      inputPath,
      inputMimeType,
      width,
      height,
      engine: String(payload?.engine || 'auto'),
      tags: parseStringArrayField(payload?.tags),
      smartCategories: parseStringArrayField(payload?.smartCategories),
    };
    const fallback = inferImageAnalysisFallback(normalizedPayload);
    const preferredRuntime = {
      provider: String(payload?.provider || '').trim(),
      model: String(payload?.model || '').trim(),
    };
    const runtime = resolveImageAnalysisRuntime(
      normalizedPayload.engine,
      preferredRuntime.provider ? preferredRuntime : null,
    );
    fallback.runtime = {
      ...(fallback.runtime || {}),
      requestedEngine: runtime.requested,
      resolvedEngine: runtime.resolved,
      wrapperConfigured: Boolean(runtime.commandLine) || runtime.mode === 'remote',
      wrapperCommand: runtime.commandLine ? runtime.resolved : runtime.mode === 'remote' ? 'custom-api' : '',
      provider: String(runtime.remoteProvider || '').trim(),
      model: String(runtime.remoteModel || '').trim(),
      endpoint: String(runtime.remoteEndpoint || '').trim(),
      modelLabel: modelLabelForRuntime({
        mode: runtime.mode,
        resolvedEngine: runtime.resolved,
        provider: runtime.remoteProvider,
        model: runtime.remoteModel,
        fusionEngines: runtime.fusionEngines,
      }),
    };
    fallback.metadata = {
      ...(fallback.metadata || {}),
      requestedEngine: runtime.requested,
      resolvedEngine: runtime.resolved,
    };

    if (!runtime.commandLine) {
      if (runtime.mode === 'remote') {
        return await runRemoteImageAnalysis(runtime, normalizedPayload, fallback);
      }
      return fallback;
    }

    if (runtime.mode === 'fusion') {
      return await runFusedImageAnalysis(runtime, normalizedPayload, fallback, cleanupPaths);
    }

    const localResult = await runSingleImageAnalysisEngine(runtime, normalizedPayload, fallback, cleanupPaths);
    return await refineLocalAnalysisWithFreeLlm(localResult, fallback);
  } finally {
    await Promise.all(cleanupPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
  }
}

// 本地 Florence-2 看图（免费）+ 在线免费文本 LLM 结构化中文（免费额度，轮换）：
// 把 Florence-2 的英文详细描述翻译/拆解为中文细粒度字段（颜色/细节/动作/表情等），补全本地模型短板。
async function refineLocalAnalysisWithFreeLlm(result, fallback) {
  const rawCaption = String(result?.rawCaption || result?.metadata?.segments?.join(' ') || '').trim();
  const engineStr = `${result?.engine || ''} ${fallback?.runtime?.wrapperCommand || ''} ${fallback?.runtime?.resolvedEngine || ''}`;
  const isLocalFlorence = /florence/i.test(engineStr);
  if (!rawCaption || !isLocalFlorence) return result;
  const candidate = nextFreeLlm('chat');
  if (!candidate) return result;
  const apiKey = String(candidate.apiKey || process.env.HMDAO_AI_KEY || '').trim();
  const apiUrl = String(candidate.endpoint || process.env.HMDAO_AI_URL || 'https://tokenhub.tencentmaas.com/v1/chat/completions').trim();
  const model = String(candidate.model || process.env.HMDAO_AI_MODEL || 'hy3').trim();
  const prompt = `下面是一段英文图片描述（来自 Florence-2 视觉模型）。请翻译成中文，并拆解为结构化字段，只返回 JSON，不要额外解释：\n{ "subject":"中文主体描述", "subjectColors":"具体颜色如酒红色丝绒", "subjectDetails":"材质/纹理/服饰/细节", "action":"动作或姿态，无则写静态", "expression":"表情，无人物脸部写none", "scene":"场景", "style":"风格", "lighting":"光影", "camera":"镜头/运镜", "mood":"情绪", "promptZh":"可复现的中文生成提示词(可附推荐模型与比例)", "promptEn":"英文生成提示词" }\n英文描述：${rawCaption}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1200 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return result;
    const data = await r.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return result;
    const parsed = JSON.parse(jsonMatch[0]);
    const fill = (v) => (typeof v === 'string' && v.trim() && !/^(none|无|待|未|需在线|static)/i.test(v.trim())) ? v.trim() : null;
    const merged = { ...result };
    const map = {
      subject: 'subject', subjectColors: 'subjectColors', subjectDetails: 'subjectDetails',
      action: 'action', expression: 'expression', scene: 'scene', style: 'style',
      lighting: 'lighting', camera: 'camera', mood: 'mood', promptZh: 'promptZh', promptEn: 'promptEn',
    };
    for (const [src, dst] of Object.entries(map)) {
      const v = fill(parsed[src]);
      if (v) merged[dst] = v;
    }
    if (parsed.summary) merged.summary = String(parsed.summary).trim();
    merged.runtime = {
      ...(merged.runtime || {}),
      refinedByLlm: model,
      modelLabel: `本地 Florence-2 看图 + 在线免费 LLM（${model}）结构化`,
    };
    return merged;
  } catch {
    return result;
  }
}

function configuredUnrealCameras() {
  const raw = String(process.env.HMDAO_UNREAL_CAMERAS || '').trim();
  if (!raw) return DCC_CAMERA_SETS.unreal.map((name, index) => ({ name, label: name, active: index === 0, engine: 'unreal' }));
  return raw.split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name, index) => ({ name, label: name, active: index === 0, engine: 'unreal' }));
}

async function readUnrealConfig() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(UNREAL_CONFIG_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUnrealConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(UNREAL_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function getUnrealControlConfig() {
  const stored = await readUnrealConfig();
  const controlObjectPath = String(process.env.HMDAO_UNREAL_CONTROL_OBJECT_PATH || stored.controlObjectPath || '').trim();
  const cameraFunction = String(process.env.HMDAO_UNREAL_CAMERA_FUNCTION || stored.cameraFunction || 'SetHMDaoCamera').trim() || 'SetHMDaoCamera';
  const signalUrl = String(process.env.HMDAO_UNREAL_SIGNAL_URL || stored.signalUrl || 'ws://127.0.0.1:8888').trim();
  return {
    controlObjectPath,
    cameraFunction,
    signalUrl,
    configured: Boolean(controlObjectPath),
    source: process.env.HMDAO_UNREAL_CONTROL_OBJECT_PATH ? 'env' : stored.controlObjectPath ? 'file' : 'unset',
  };
}

const UNREAL_PIXEL_STREAMING_LEGACY = createUnrealPixelStreamingLegacyModule({
  repoRoot: REPO_ROOT,
  getControlConfig: getUnrealControlConfig,
  nativeHttpRequest,
  probeTcp,
  normalizeHttpUrl,
  configuredUnrealCameras,
  defaultPixelUrl: DEFAULT_UNREAL_PIXEL_URL,
  defaultRemoteUrl: DEFAULT_UNREAL_REMOTE_URL,
  send,
  sendRaw,
});

async function callUnrealCameraSwitch(remoteUrl, cameraName) {
  const controlConfig = await getUnrealControlConfig();
  const objectPath = controlConfig.controlObjectPath;
  const functionName = controlConfig.cameraFunction;
  if (!objectPath) return { called: false, reason: 'HMDAO_UNREAL_CONTROL_OBJECT_PATH is required.' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${remoteUrl}/remote/object/call`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        objectPath,
        functionName,
        parameters: { CameraName: cameraName, cameraName },
        generateTransaction: false,
      }),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { called: response.ok, status: response.status, data };
  } catch (error) {
    return { called: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function connectUpstreamWebSocket(config, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: config.port });
    const key = crypto.randomBytes(16).toString('base64');
    let handshake = Buffer.alloc(0);
    let settled = false;
    let parserReady = false;
    const timeout = setTimeout(() => fail(new Error('DCC connection timed out.')), timeoutMs);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }

    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('DCC socket timeout.')));
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write([
        'GET /ws/dcc-capture HTTP/1.1',
        `Host: 127.0.0.1:${config.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });

    socket.on('data', (chunk) => {
      if (parserReady) return;
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = handshake.subarray(0, headerEnd).toString('utf8');
      if (!/^HTTP\/1\.1 101/i.test(header)) return fail(new Error('DCC websocket handshake failed.'));
      settled = true;
      parserReady = true;
      clearTimeout(timeout);
      socket.setTimeout(0);
      socket.removeAllListeners('error');
      const rest = handshake.subarray(headerEnd + 4);
      resolve({ socket, rest });
    });
  });
}

class DccMockSession {
  constructor(socket, engine) {
    this.socket = socket;
    this.engine = engine;
    this.config = engineConfig(engine);
    this.width = 1280;
    this.height = 720;
    this.fps = 15;
    this.frameIndex = 1;
    this.selectedCamera = DCC_CAMERA_SETS[engine][0];
    this.previewTimer = null;
    this.recording = false;
  }

  close() {
    if (this.previewTimer) clearInterval(this.previewTimer);
    this.previewTimer = null;
    if (DCC_RECORDING_LOCK.engine === this.engine) DCC_RECORDING_LOCK.engine = null;
  }

  send(payload) {
    sendWs(this.socket, payload);
  }

  cameras() {
    return DCC_CAMERA_SETS[this.engine].map((name) => ({ name, label: name, active: name === this.selectedCamera, engine: this.engine }));
  }

  sendCameraList() {
    this.send({ type: 'camera_list', camera_list: this.cameras(), selected_camera: this.selectedCamera });
  }

  sendTimeline() {
    this.send({ type: 'animation_range', start_frame: 1, end_frame: this.engine === 'unreal' ? 144 : 120, current_frame: this.frameIndex, fps: this.engine === 'unreal' ? 30 : 24 });
  }

  sendFrame() {
    const url = dccFrameDataUrl({
      engine: this.engine,
      cameraName: this.selectedCamera,
      width: this.width,
      height: this.height,
      frameIndex: this.frameIndex++,
      recording: this.recording,
    });
    this.send({
      type: 'frame',
      url,
      width: this.width,
      height: this.height,
      camera_name: this.selectedCamera,
      latency_ms: 6,
      mock: true,
      source: 'mock',
    });
  }

  startPreview(payload = {}) {
    this.width = Number(payload.w || payload.width || this.width);
    this.height = Number(payload.h || payload.height || this.height);
    this.fps = Math.min(30, Math.max(8, Number(payload.fps || this.fps)));
    if (payload.camera_name) this.selectedCamera = String(payload.camera_name);
    if (this.previewTimer) clearInterval(this.previewTimer);
    this.sendFrame();
    this.previewTimer = setInterval(() => this.sendFrame(), Math.round(1000 / this.fps));
  }

  capture(payload = {}) {
    const width = Number(payload.w || payload.width || this.width);
    const height = Number(payload.h || payload.height || this.height);
    const cameraName = String(payload.camera_name || this.selectedCamera);
    const url = dccFrameDataUrl({ engine: this.engine, cameraName, width, height, frameIndex: this.frameIndex++, recording: false });
    this.send({
      type: 'capture_done',
      url,
      width,
      height,
      camera_name: cameraName,
      size_bytes: Buffer.byteLength(url),
      mock: true,
      source: 'mock',
    });
  }

  startRecording(payload = {}) {
    if (DCC_RECORDING_LOCK.engine && DCC_RECORDING_LOCK.engine !== this.engine) {
      this.send({ type: 'error', message: `${engineConfig(DCC_RECORDING_LOCK.engine).label} is already recording. Stop that session before starting ${this.config.label}.` });
      return;
    }
    DCC_RECORDING_LOCK.engine = this.engine;
    this.recording = true;
    this.width = Number(payload.w || payload.width || this.width);
    this.height = Number(payload.h || payload.height || this.height);
    if (payload.camera_name) this.selectedCamera = String(payload.camera_name);
    this.startPreview({ ...payload, fps: payload.fps || this.fps });
    this.send({ type: 'recording_started', camera_name: this.selectedCamera, start_frame: payload.start_frame, end_frame: payload.end_frame, fps: payload.fps, mock: true });
  }

  stopRecording() {
    this.recording = false;
    if (DCC_RECORDING_LOCK.engine === this.engine) DCC_RECORDING_LOCK.engine = null;
    this.send({ type: 'recording_stopped', camera_name: this.selectedCamera, mock: true });
  }

  handle(payload) {
    const type = String(payload.type || '');
    if (payload.engine) {
      this.engine = payload.engine === 'unreal' ? 'unreal' : 'blender';
      this.config = engineConfig(this.engine);
      if (!DCC_CAMERA_SETS[this.engine].includes(this.selectedCamera)) this.selectedCamera = DCC_CAMERA_SETS[this.engine][0];
    }
    if (type === 'connect') {
      this.send({ type: 'connected', engine: this.engine, mode: 'mock', message: `${this.config.label} mock session is active. Install or connect ${this.config.pluginName} to enable real-time capture.` });
      this.sendCameraList();
      this.sendTimeline();
      return;
    }
    if (type === 'query_camera') return this.sendCameraList();
    if (type === 'query_animation_range') return this.sendTimeline();
    if (type === 'set_camera') {
      if (payload.camera_name) this.selectedCamera = String(payload.camera_name);
      this.sendCameraList();
      this.sendTimeline();
      this.sendFrame();
      return;
    }
    if (type === 'start_preview') return this.startPreview(payload);
    if (type === 'stop_preview') {
      if (this.previewTimer) clearInterval(this.previewTimer);
      this.previewTimer = null;
      return;
    }
    if (type === 'capture_by_camera') return this.capture(payload);
    if (type === 'start_recording') return this.startRecording(payload);
    if (type === 'stop_recording') return this.stopRecording();
  }
}

function normalizeUnrealDirectFromPlugin(payload) {
  const type = String(payload.type || '');
  if (type === 'hello') {
    return {
      type: 'connected',
      engine: 'unreal',
      mode: 'real',
      message: 'HMDao Unreal Capture connected to Unreal Editor.',
      plugin: payload.plugin || 'HMDao Unreal Capture',
      pluginVersion: payload.pluginVersion || payload.plugin_version || '',
      previewProvider: 'editor-direct',
    };
  }
  if (type === 'state') {
    return {
      ...payload,
      type: 'connected',
      engine: 'unreal',
      mode: 'real',
      message: payload.message || 'Unreal Editor connected.',
    };
  }
  if (type === 'preview_frame') {
    return {
      type: 'frame',
      url: payload.url || (payload.payload ? `data:${payload.mimeType || payload.mime_type || 'image/jpeg'};base64,${payload.payload}` : ''),
      width: Number(payload.width || 1280),
      height: Number(payload.height || 720),
      camera_name: payload.cameraName || payload.camera_name || payload.selectedCameraName || 'Unreal Camera',
      latency_ms: Number(payload.latencyMs || payload.latency_ms || 0),
      source: 'editor-direct',
      mock: false,
    };
  }
  if (type === 'capture_done' && payload.asset && typeof payload.asset === 'object') {
  const asset = payload.asset;
  const filePath = asset.filePath || asset.file_path || '';
  const mimeType = asset.mimeType || asset.mime_type || 'image/png';
  const thumbnailFilePath = asset.thumbnailFilePath || asset.thumbnail_file_path || '';
  const thumbnailMimeType = asset.thumbnailMimeType || asset.thumbnail_mime_type || 'image/jpeg';
  const assetUrl = asset.url
    || (asset.payload ? `data:${mimeType};base64,${asset.payload}` : '')
    || (filePath ? registerDccLocalArtifactUrl(filePath, mimeType) : '');
  const thumbnailUrl = asset.thumbnailUrl
    || asset.thumbnail_url
    || (asset.thumbnailPayload ? `data:${thumbnailMimeType};base64,${asset.thumbnailPayload}` : '')
    || (thumbnailFilePath ? registerDccLocalArtifactUrl(thumbnailFilePath, thumbnailMimeType) : '');
  return {
    type: 'capture_done',
    url: assetUrl,
    width: Number(asset.width || payload.width || 1920),
    height: Number(asset.height || payload.height || 1080),
    camera_name: asset.cameraName || asset.camera_name || payload.cameraName || 'Unreal Camera',
    size_bytes: Number(asset.sizeBytes || asset.size_bytes || 0),
    file_path: filePath,
    mime_type: mimeType,
    managed_url: Boolean(asset.managedUrl || asset.managed_url || assetUrl.startsWith('/api/')),
    thumbnail_url: thumbnailUrl || assetUrl,
    thumbnail_file_path: thumbnailFilePath,
    source: 'editor-direct',
    mock: false,
  };
}
  if (type === 'recording_done' && payload.asset && typeof payload.asset === 'object') {
  const asset = payload.asset;
  const filePath = asset.filePath || asset.file_path || '';
  const mimeType = asset.mimeType || asset.mime_type || 'video/webm';
  const thumbnailFilePath = asset.thumbnailFilePath || asset.thumbnail_file_path || '';
  const thumbnailMimeType = asset.thumbnailMimeType || asset.thumbnail_mime_type || 'image/jpeg';
  const assetUrl = asset.url
    || (asset.payload ? `data:${mimeType};base64,${asset.payload}` : '')
    || (filePath ? registerDccLocalArtifactUrl(filePath, mimeType) : '');
  const thumbnailUrl = asset.thumbnailUrl
    || asset.thumbnail_url
    || (asset.thumbnailPayload ? `data:${thumbnailMimeType};base64,${asset.thumbnailPayload}` : '')
    || (thumbnailFilePath ? registerDccLocalArtifactUrl(thumbnailFilePath, thumbnailMimeType) : '');
  return {
    type: 'recording_done',
    url: assetUrl,
    width: Number(asset.width || payload.width || 1920),
    height: Number(asset.height || payload.height || 1080),
    camera_name: asset.cameraName || asset.camera_name || payload.cameraName || 'Unreal Camera',
    size_bytes: Number(asset.sizeBytes || asset.size_bytes || 0),
    file_path: filePath,
    mime_type: mimeType,
    managed_url: Boolean(asset.managedUrl || asset.managed_url || assetUrl.startsWith('/api/')),
    duration_ms: Number(asset.durationMs || asset.duration_ms || payload.durationMs || payload.duration_ms || 0),
    thumbnail_url: thumbnailUrl,
    thumbnail_file_path: thumbnailFilePath,
    source: 'editor-direct',
    mock: false,
  };
}
  return payload;
}

function normalizeUnrealCommandForPlugin(payload) {
  const type = String(payload.type || '');
  if (type === 'connect') return { type: 'query_state', engine: 'unreal' };
  if (type === 'query_camera') return { type: 'query_cameras' };
  if (type === 'query_animation_range') return { type: 'query_timeline', cameraName: payload.camera_name || payload.cameraName || '' };
  if (type === 'set_camera') return { type: 'set_camera', cameraName: payload.camera_name || payload.cameraName || '', cameraId: payload.camera_id || payload.cameraId || '' };
  if (type === 'start_preview') {
    return {
      type: 'start_preview',
      cameraName: payload.camera_name || payload.cameraName || '',
      width: Number(payload.w || payload.width || 1280),
      height: Number(payload.h || payload.height || 720),
      fps: Number(payload.fps || 30),
      quality: Number(payload.quality || 82),
      format: payload.format || 'jpeg',
    };
  }
  if (type === 'capture_by_camera') {
    return {
      type: 'capture',
      requestId: `cap-${Date.now()}`,
      cameraName: payload.camera_name || payload.cameraName || '',
      width: Number(payload.w || payload.width || 1920),
      height: Number(payload.h || payload.height || 1080),
      format: payload.format || 'png',
      quality: Number(payload.quality || 95),
    };
  }
  if (type === 'start_recording') {
    // The Unreal plugin's playback-driven recording path (HMDaoUnrealCaptureModule.cpp)
    // reads the recording resolution from `captureWidth`/`captureHeight` (fallback
    // `recordWidth`/`recordHeight`), NOT from `width`/`height` (those only drive the
    // live preview). If we only forward width/height, the user's panel resolution is
    // silently ignored and every recording renders at the 1920x1080 default. Mirror
    // the chosen resolution into the captureWidth/Height + recordWidth/Height fields so
    // the recording output actually matches the DCC panel selection.
    const recordWidth = Number(payload.w || payload.width || 1920);
    const recordHeight = Number(payload.h || payload.height || 1080);
    return {
      type: 'start_recording',
      requestId: `rec-${Date.now()}`,
      cameraName: payload.camera_name || payload.cameraName || '',
      startFrame: Number((payload.start_frame ?? payload.startFrame) ?? 1),
      endFrame: Number((payload.end_frame ?? payload.endFrame) ?? 120),
      fps: Number(payload.fps || 24),
      width: recordWidth,
      height: recordHeight,
      captureWidth: recordWidth,
      captureHeight: recordHeight,
      recordWidth,
      recordHeight,
      format: payload.format || 'webm',
    };
  }
  if (type === 'stop_recording') return { type: 'stop_recording', cameraName: payload.camera_name || payload.cameraName || '' };
  return payload;
}

function sendUnrealDirectToBrowsers(bridge, payload) {
  const message = normalizeUnrealDirectFromPlugin(payload);
  if (message.type === 'camera_list') bridge.lastCameraList = message;
  if (message.type === 'animation_range' || message.type === 'timeline' || message.type === 'scene_info') bridge.lastTimeline = message;
  for (const browser of bridge.browsers.values()) {
    if (!browser.socket.destroyed) sendWs(browser.socket, message);
  }
}

function handleUnrealPluginUpgrade(req, socket, head) {
  const owner = resolveDccOwnerFromWs(req);
  // 云端部署下未带有效 token 的插件连接直接拒绝，防止占满别人的桶。
  if (owner === 'local' && !isDccLocalOnlyConnection(req) && !process.env.HMDAO_DCC_ALLOW_ANON) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const bridge = getUnrealDirectBridge(owner);
  if (bridge.pluginSocket && !bridge.pluginSocket.destroyed) {
    logUnrealBridgeEvent('plugin-session-replaced', {
      owner: bridge.owner,
      previousPlugin: bridge.pluginInfo?.plugin || 'unknown',
      browserCount: bridge.browsers.size,
    });
    sendWs(bridge.pluginSocket, { type: 'error', message: 'A newer HMDao Unreal Capture plugin session has connected.' });
    bridge.pluginSocket.destroy();
  }
  bridge.pluginSocket = socket;
  bridge.pluginInfo = { connectedAt: Date.now() };
  bridge.lastCameraList = null;
  bridge.lastTimeline = null;
  logUnrealBridgeEvent('plugin-connected', {
    owner: bridge.owner,
    browserCount: bridge.browsers.size,
  });
  sendUnrealDirectToBrowsers(bridge, { type: 'connected', engine: 'unreal', mode: 'real', message: 'HMDao Unreal Capture connected.' });
  let helloAckSent = false;
  const sendHelloAck = () => {
    if (helloAckSent || socket.destroyed) return;
    helloAckSent = true;
    sendWs(socket, {
      type: 'hello_ack',
      sessionId: `dcc-unreal-${Date.now()}`,
      accepted: true,
      heartbeatIntervalMs: 5000,
      uploadBaseUrl: `${getRequestOrigin(req)}/api/dcc/assets/upload`,
    });
  };

  const parser = createFrameParser((text) => {
    let payload;
    try { payload = JSON.parse(text); } catch { return; }
    if (payload.type === 'ping') {
      sendHelloAck();
      sendWs(socket, {
        type: 'pong',
        ts: Number(payload.ts || Date.now()),
        serverTs: Date.now(),
      });
      return;
    }
    if (payload.type === 'hello') {
      sendHelloAck();
      bridge.pluginInfo = { ...bridge.pluginInfo, ...payload, connectedAt: bridge.pluginInfo?.connectedAt || Date.now() };
      logUnrealBridgeEvent('plugin-hello', {
        owner: bridge.owner,
        plugin: payload.plugin || 'unknown',
        pluginVersion: payload.pluginVersion || '',
        previewProvider: payload.previewProvider || '',
      });
    }
    if (payload.type !== 'pong' && payload.type !== 'hello_ack') {
      sendWs(socket, {
        type: 'pong',
        ts: Number(payload.ts || Date.now()),
        serverTs: Date.now(),
      });
    }
    sendUnrealDirectToBrowsers(bridge, payload);
  }, () => socket.destroy(), (payload) => {
    if (!socket.destroyed) socket.write(encodeWsFrame(payload, { opcode: 0xA }));
  });

  socket.on('data', parser);
  socket.on('close', () => {
    if (bridge.pluginSocket === socket) {
      bridge.pluginSocket = null;
      bridge.pluginInfo = null;
      bridge.lastCameraList = null;
      bridge.lastTimeline = null;
      sendUnrealDirectToBrowsers(bridge, { type: 'error', message: 'HMDao Unreal Capture disconnected.' });
    }
    logUnrealBridgeEvent('plugin-disconnected', {
      owner: bridge.owner,
      browserCount: bridge.browsers.size,
    });
  });
  socket.on('error', (error) => {
    logUnrealBridgeEvent('plugin-socket-error', {
      owner: bridge.owner,
      message: error instanceof Error ? error.message : String(error || ''),
    });
    socket.destroy();
  });
  if (head?.length) parser(head);
}

function handleUnrealBrowserUpgrade(req, socket, head) {
  const owner = resolveDccOwnerFromWs(req);
  // 云端部署下未带有效 token 的浏览器连接直接拒绝，防止串流他人引擎。
  if (owner === 'local' && !isDccLocalOnlyConnection(req) && !process.env.HMDAO_DCC_ALLOW_ANON) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const bridge = getUnrealDirectBridge(owner);
  const browserId = crypto.randomUUID();
  const mockSession = new DccMockSession(socket, 'unreal');
  const browserSession = {
    socket,
    mockSession,
    requireReal: false,
    sawReal: false,
  };
  bridge.browsers.set(browserId, browserSession);

  const rejectMockFallback = (message) => {
    sendWs(socket, {
      type: browserSession.sawReal ? 'error' : 'connect_error',
      message,
    });
  };

  const parser = createFrameParser((text) => {
    let payload;
    try { payload = JSON.parse(text); } catch {
      sendWs(socket, { type: 'error', message: 'Unreal direct bridge received an invalid message.' });
      return;
    }
    if (String(payload.type || '') === 'connect') {
      browserSession.requireReal = payload.require_real === true || payload.allow_mock === false || browserSession.requireReal;
    }
    const plugin = bridge.pluginSocket;
    if (plugin && !plugin.destroyed) {
      browserSession.sawReal = true;
      if (String(payload.type || '') === 'connect') {
        sendWs(socket, { type: 'connected', engine: 'unreal', mode: 'real', message: 'HMDao Unreal Capture is online.' });
        if (bridge.lastCameraList) sendWs(socket, bridge.lastCameraList);
        if (bridge.lastTimeline) sendWs(socket, bridge.lastTimeline);
      }
      plugin.write(encodeWsFrame(JSON.stringify(normalizeUnrealCommandForPlugin(payload))));
      return;
    }
    if (browserSession.requireReal || browserSession.sawReal) {
      rejectMockFallback(browserSession.sawReal
        ? 'HMDao Unreal Capture disconnected.'
        : 'HMDao Unreal Capture is not online. Open Unreal Editor with the HMDao Unreal Capture plugin before connecting.');
      return;
    }
    mockSession.handle(payload);
  }, () => socket.destroy(), (payload) => {
    if (!socket.destroyed) socket.write(encodeWsFrame(payload, { opcode: 0xA }));
  });

  socket.on('data', parser);
  socket.on('close', () => {
    mockSession.close();
    bridge.browsers.delete(browserId);
  });
  socket.on('error', () => {
    mockSession.close();
    bridge.browsers.delete(browserId);
  });
  if (head?.length) parser(head);
}

async function handleDccUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const directUnreal = url.pathname === '/ws/dcc/unreal';
  if (url.pathname !== '/ws/dcc-capture' && !directUnreal) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const rawProtocols = typeof req.headers['sec-websocket-protocol'] === 'string'
    ? req.headers['sec-websocket-protocol']
    : Array.isArray(req.headers['sec-websocket-protocol'])
      ? req.headers['sec-websocket-protocol'].join(',')
      : '';
  const selectedProtocol = rawProtocols
    .split(',')
    .map((item) => item.trim())
    .find(Boolean) || '';

  if (directUnreal) {
    logUnrealBridgeEvent('upgrade-request', {
      role: String(url.searchParams.get('role') || 'browser').toLowerCase(),
      protocol: selectedProtocol,
      userAgent: req.headers['user-agent'] || '',
    });
  }

  const upgradeResponseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (selectedProtocol) {
    upgradeResponseHeaders.push(`Sec-WebSocket-Protocol: ${selectedProtocol}`);
  }
  upgradeResponseHeaders.push('\r\n');
  socket.write(upgradeResponseHeaders.join('\r\n'));

  if (directUnreal) {
    const role = String(url.searchParams.get('role') || 'browser').toLowerCase();
    if (role === 'plugin') handleUnrealPluginUpgrade(req, socket, head);
    else handleUnrealBrowserUpgrade(req, socket, head);
    return;
  }

  let engine = directUnreal ? 'unreal' : url.searchParams.get('engine') === 'unreal' ? 'unreal' : 'blender';
  const allowReal = !directUnreal && process.env.HMDAO_DCC_MOCK_ONLY !== '1';
  const allowMockFallback = process.env.HMDAO_DCC_MOCK_ONLY === '1'
    || engine === 'unreal'
    || process.env.HMDAO_ALLOW_BLENDER_MOCK === '1';
  let mode = allowReal ? 'connecting' : 'mock';
  let mockSession = new DccMockSession(socket, engine);
  let upstream = null;
  const pendingBrowserPayloads = [];

  const browserParser = createFrameParser(async (text) => {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      sendWs(socket, { type: 'error', message: 'DCC gateway received an invalid message.' });
      return;
    }
    if (payload.engine) engine = payload.engine === 'unreal' ? 'unreal' : 'blender';
    if (mode === 'connecting') {
      pendingBrowserPayloads.push(payload);
      return;
    }
    if (mode === 'real' && upstream?.socket && !upstream.socket.destroyed) {
      upstream.socket.write(encodeWsFrame(JSON.stringify(payload), { masked: true }));
      return;
    }
    mockSession.handle(payload);
  }, () => socket.destroy());

  socket.on('data', browserParser);
  socket.on('close', () => {
    mockSession.close();
    upstream?.socket?.destroy();
  });
  socket.on('error', () => {
    mockSession.close();
    upstream?.socket?.destroy();
  });

  if (head?.length) browserParser(head);

  const config = engineConfig(engine);
  if (allowReal) {
    try {
      upstream = await connectUpstreamWebSocket(config);
      mode = 'real';
      mockSession.close();
      sendWs(socket, { type: 'connected', engine, mode: 'real', message: `${config.pluginName} connected. HMDao DCC is now streaming live ${config.label} data.` });
      const upstreamParser = createFrameParser((message) => {
        if (!socket.destroyed) socket.write(encodeWsFrame(message));
      }, () => {
        if (!socket.destroyed) sendWs(socket, { type: 'error', message: `${config.pluginName} disconnected. Switching browser client back to mock ${config.label} mode.` });
        mode = 'mock';
        mockSession = new DccMockSession(socket, engine);
      });
      upstream.socket.on('data', upstreamParser);
      upstream.socket.on('close', () => {
        mode = 'mock';
        mockSession = new DccMockSession(socket, engine);
      });
      upstream.socket.on('error', () => {
        mode = 'mock';
        mockSession = new DccMockSession(socket, engine);
      });
      if (upstream.rest?.length) upstreamParser(upstream.rest);
      for (const payload of pendingBrowserPayloads.splice(0)) {
        if (upstream?.socket && !upstream.socket.destroyed) {
          upstream.socket.write(encodeWsFrame(JSON.stringify(payload), { masked: true }));
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (allowMockFallback) {
        mode = 'mock';
        sendWs(socket, {
          type: 'connected',
          engine,
          mode: 'mock',
          message: `${config.pluginName} ?? ${config.port} ??? HMDao WebSocket ???${reason}?????????????? ${config.label} ????????`,
        });
        mockSession.sendCameraList();
        mockSession.sendTimeline();
        for (const payload of pendingBrowserPayloads.splice(0)) mockSession.handle(payload);
      } else {
        mode = 'error';
        sendWs(socket, {
          type: 'error',
          engine,
          message: `${config.pluginName} ?????????????????${reason}??? ${config.label} ????????????????`,
        });
      }
    }
  } else {
    sendWs(socket, { type: 'connected', engine, mode: 'mock', message: `${config.label} mock DCC mode is active because no live upstream connection is enabled.` });
    mockSession.sendCameraList();
    mockSession.sendTimeline();
  }
}

async function handleWorkflowUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws/workflow') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    '\r\n',
  ].join('\r\n'));

  const socketId = crypto.randomUUID();
  workflowSocketSubscriptions.set(socketId, socket);

  const parser = createFrameParser(async (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendWs(socket, {
        msg_id: nextMessageId(),
        msg_type: 'error',
        payload: { error: 'Workflow WebSocket message is not valid JSON.' },
        ts: Date.now(),
      });
      return;
    }

    const msgType = String(message.msg_type || '');
    const requestId = String(message.msg_id || nextMessageId());
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};

    if (msgType === 'ping') {
      sendWs(socket, { msg_id: requestId, msg_type: 'pong', payload: {}, ts: Date.now() });
      return;
    }

    if (msgType === 'workflow:create') {
      const workflow = payload.workflow;
      if (!workflow || !Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
        sendWs(socket, {
          msg_id: requestId,
          msg_type: 'error',
          payload: { request_id: requestId, error: 'workflow.nodes cannot be empty.' },
          ts: Date.now(),
        });
        return;
      }

      const workflowId = nextWorkflowId();
      const run = {
        workflowId,
        requestId,
        name: String(workflow.name || workflowId),
        nodes: workflow.nodes.map((node) => ({
          node_id: String(node.node_id || crypto.randomUUID()),
          nodeType: node.nodeType,
          provider: String(node.provider || ''),
          model: String(node.model || ''),
          prompt: String(node.prompt || ''),
          endpoint: String(node.endpoint || ''),
          body: node.body && typeof node.body === 'object' ? node.body : {},
          apiKey: typeof node.apiKey === 'string' ? node.apiKey : '',
          timeout: Number(node.timeout || 90_000),
          depends_on: Array.isArray(node.depends_on) ? node.depends_on.map((item) => String(item)) : [],
          metadata: node.metadata && typeof node.metadata === 'object' ? node.metadata : {},
        })),
        status: 'accepted',
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nodeResults: new Map(),
        subscribers: new Set([socket]),
      };

      workflowRuns.set(workflowId, run);
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'workflow:accepted',
        payload: workflowStatusSnapshot(run),
        ts: Date.now(),
      });
      void executeWorkflowRun(run);
      return;
    }

    if (msgType === 'status:query') {
      const workflowId = String(payload.workflow_id || '');
      const run = workflowRuns.get(workflowId);
      if (!run) {
        sendWs(socket, {
          msg_id: requestId,
          msg_type: 'error',
          payload: { request_id: requestId, workflow_id: workflowId, error: 'Workflow not found.' },
          ts: Date.now(),
        });
        return;
      }
      if (payload.subscribe !== false) run.subscribers.add(socket);
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'status:result',
        payload: workflowStatusSnapshot(run),
        ts: Date.now(),
      });
      return;
    }

    if (msgType === 'workflow:control') {
      const workflowId = String(payload.workflow_id || '');
      const action = String(payload.action || '');
      const run = workflowRuns.get(workflowId);
      if (!run) {
        sendWs(socket, {
          msg_id: requestId,
          msg_type: 'error',
          payload: { request_id: requestId, workflow_id: workflowId, error: 'Workflow not found.' },
          ts: Date.now(),
        });
        return;
      }
      run.subscribers.add(socket);
      if (action === 'cancel') {
        run.status = 'cancelled';
        run.updatedAt = Date.now();
        publishWorkflowEvent(run, 'workflow:cancelled');
        return;
      }
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'status:result',
        payload: workflowStatusSnapshot(run),
        ts: Date.now(),
      });
      return;
    }

    sendWs(socket, {
      msg_id: requestId,
      msg_type: 'error',
      payload: { request_id: requestId, error: `Unsupported DCC message type: ${msgType}` },
      ts: Date.now(),
    });
  }, () => {
    workflowSocketSubscriptions.delete(socketId);
    for (const run of workflowRuns.values()) {
      run.subscribers.delete(socket);
    }
    socket.destroy();
  });

  socket.on('data', parser);
  socket.on('close', () => {
    workflowSocketSubscriptions.delete(socketId);
    for (const run of workflowRuns.values()) {
      run.subscribers.delete(socket);
    }
  });
  socket.on('error', () => {
    workflowSocketSubscriptions.delete(socketId);
    for (const run of workflowRuns.values()) {
      run.subscribers.delete(socket);
    }
  });

  if (head?.length) parser(head);
}

async function handleCatalogUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws/catalog') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    '\r\n',
  ].join('\r\n'));

  const socketId = crypto.randomUUID();
  catalogSocketSubscriptions.set(socketId, socket);

  const parser = createFrameParser((text) => {
    let message = {};
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const msgType = String(message.msg_type || '');
    const requestId = String(message.msg_id || nextMessageId());
    if (msgType === 'ping') {
      sendWs(socket, { msg_id: requestId, msg_type: 'pong', payload: {}, ts: Date.now() });
      return;
    }
    if (msgType === 'catalog:subscribe') {
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'catalog:updated',
        payload: {
          reason: 'initial-sync',
          updated_at: Date.now(),
          models: modelCatalogPayload(),
        },
        ts: Date.now(),
      });
    }
  }, () => {
    catalogSocketSubscriptions.delete(socketId);
    socket.destroy();
  });

  socket.on('data', parser);
  socket.on('close', () => catalogSocketSubscriptions.delete(socketId));
  socket.on('error', () => catalogSocketSubscriptions.delete(socketId));
  if (head?.length) parser(head);
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      }
    : {
        // 未命中白名单：不发送 CORS 头（收紧，避免 *)
      };
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders,
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Type, X-HMDAO-Media-Error, X-HMDAO-Media-Provider',
    ...headers,
  });
  res.end(body);
}

function sendRaw(res, status, body, headers = {}) {
  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      }
    : {
        // 未命中白名单：不发送 CORS 头（收紧，避免 *)
      };
  res.writeHead(status, {
    ...corsHeaders,
    'Access-Control-Allow-Headers': 'content-type, authorization, range',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified, X-HMDAO-Media-Error, X-HMDAO-Media-Provider',
    ...headers,
  });
  res.end(body);
}

async function sendLocalFileStream(req, res, filePath, options = {}) {
  const stat = await fs.stat(filePath);
  const total = Number(stat.size || 0);
  const mimeType = String(options.mimeType || mediaMimeTypeFromExtension(filePath));
  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      }
    : {
        // 未命中白名单：不发送 CORS 头（收紧，避免 *)
      };
  const baseHeaders = {
    ...corsHeaders,
    'Access-Control-Allow-Headers': 'content-type, authorization, range',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified',
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
    'Last-Modified': stat.mtime.toUTCString(),
    ...(options.contentDisposition ? { 'Content-Disposition': String(options.contentDisposition) } : {}),
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
  };

  const range = String(req.headers.range || '').trim();
  if (!range) {
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(total),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match) {
    res.writeHead(416, {
      ...baseHeaders,
      'Content-Range': `bytes */${total}`,
    });
    res.end();
    return;
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  }
  start = Math.max(0, start);
  end = Math.min(total - 1, end);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.writeHead(416, {
      ...baseHeaders,
      'Content-Range': `bytes */${total}`,
    });
    res.end();
    return;
  }

  res.writeHead(206, {
    ...baseHeaders,
    'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${total}`,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

async function persistLocalPostResultFile(sourcePath, requestId, mediaKind) {
  await fs.mkdir(LOCAL_POST_RESULT_DIR, { recursive: true });
  const extension = mediaKind === 'video' ? 'webm' : 'png';
  const assetId = `${requestId}.${extension}`;
  const persistedPath = path.join(LOCAL_POST_RESULT_DIR, assetId);
  await fs.rename(sourcePath, persistedPath).catch(async () => {
    await fs.copyFile(sourcePath, persistedPath);
    await fs.rm(sourcePath, { force: true }).catch(() => {});
  });
  return {
    assetId,
    persistedPath,
    outputUrl: `/api/local-post/result/${encodeURIComponent(assetId)}`,
  };
}

async function persistLocalResultFile(resultDir, sourcePath, requestId, extension) {
  await fs.mkdir(resultDir, { recursive: true });
  const normalizedExtension = String(extension || '').replace(/^\.+/, '') || 'bin';
  const assetId = `${requestId}.${normalizedExtension}`;
  const persistedPath = path.join(resultDir, assetId);
  await fs.rename(sourcePath, persistedPath).catch(async () => {
    await fs.copyFile(sourcePath, persistedPath);
    await fs.rm(sourcePath, { force: true }).catch(() => {});
  });
  return {
    assetId,
    persistedPath,
  };
}

async function persistLocalBufferResult(resultDir, sourceOrBuffer, requestId, extension) {
  await fs.mkdir(resultDir, { recursive: true });
  const normalizedExtension = String(extension || '').replace(/^\.+/, '') || 'bin';
  const assetId = `${requestId}.${normalizedExtension}`;
  const persistedPath = path.join(resultDir, assetId);
  if (Buffer.isBuffer(sourceOrBuffer)) {
    await fs.writeFile(persistedPath, sourceOrBuffer);
  } else {
    await fs.rename(sourceOrBuffer, persistedPath).catch(async () => {
      await fs.copyFile(sourceOrBuffer, persistedPath);
      await fs.rm(sourceOrBuffer, { force: true }).catch(() => {});
    });
  }
  return {
    assetId,
    persistedPath,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function readLocalPostMultipart(req) {
  await fs.mkdir(LOCAL_POST_EDIT_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const createdPaths = [];
  const fieldValues = new Map();
  const uploadedFiles = new Map();

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 24,
      fields: 128,
      fileSize: Number(process.env.HMDAO_LOCAL_POST_MAX_BYTES || 1024 * 1024 * 1024),
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const pendingWrites = [];
      let aborted = false;

      busboy.on('field', (name, value) => {
        fieldValues.set(String(name), String(value));
      });

      busboy.on('file', (name, file, info = {}) => {
        const fieldName = String(name || '').trim();
        if (!fieldName) {
          file.resume();
          return;
        }
        const ext = extensionFromMimeType(info.mimeType || 'application/octet-stream');
        const safeFieldName = sanitizeMultipartFieldName(fieldName);
        const filePath = path.join(LOCAL_POST_EDIT_DIR, `${uploadId}-${safeFieldName}.${ext}`);
        createdPaths.push(filePath);
        const writePromise = pipeline(file, createWriteStream(filePath))
          .then(() => {
            uploadedFiles.set(fieldName, {
              fieldName,
              filePath,
              filename: String(info.filename || ''),
              mimeType: String(info.mimeType || 'application/octet-stream'),
            });
          });
        pendingWrites.push(writePromise);
      });

      busboy.once('error', reject);
      busboy.once('partsLimit', () => reject(new Error('local-post-multipart-too-many-parts')));
      busboy.once('filesLimit', () => reject(new Error('local-post-multipart-too-many-files')));
      busboy.once('fieldsLimit', () => reject(new Error('local-post-multipart-too-many-fields')));
      busboy.once('finish', async () => {
        if (aborted) return;
        try {
          await Promise.all(pendingWrites);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      req.once('aborted', () => {
        aborted = true;
        reject(new Error('local-post-multipart-aborted'));
      });

      req.pipe(busboy);
    });

    const manifestText = fieldValues.get('manifest');
    if (!manifestText) {
      throw new Error('local-post-manifest-missing');
    }
    const manifest = JSON.parse(manifestText);
    const sourceField = String(manifest?.sourceField || 'source');
    const sourceFile = uploadedFiles.get(sourceField);

    return {
      mediaKind: manifest?.mediaKind === 'video' ? 'video' : 'image',
      inputMimeType: sourceFile?.mimeType || manifest?.inputMimeType || '',
      inputPath: sourceFile?.filePath || '',
      sourceUrl: String(manifest?.sourceUrl || '').trim(),
      effects: manifest?.effects && typeof manifest.effects === 'object' ? manifest.effects : {},
      assets: Array.isArray(manifest?.assets)
        ? manifest.assets.map((asset) => {
            const fieldName = String(asset?.fieldName || '');
            const uploaded = fieldName ? uploadedFiles.get(fieldName) : null;
            return {
              key: String(asset?.key || ''),
              kind: asset?.kind === 'video' ? 'video' : 'image',
              sourceUrl: String(asset?.sourceUrl || '').trim(),
              inputMimeType: uploaded?.mimeType || asset?.inputMimeType || '',
              uploadedPath: uploaded?.filePath || '',
              originalName: String(asset?.originalName || '').trim(),
            };
          })
        : [],
    };
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

async function readLocalImageAnalyzeMultipart(req) {
  await fs.mkdir(LOCAL_IMAGE_ANALYSIS_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const fieldValues = new Map();
  let uploadedFile = null;
  const createdPaths = [];
  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fields: 32,
      fileSize: Number(process.env.HMDAO_LOCAL_IMAGE_ANALYSIS_MAX_BYTES || 128 * 1024 * 1024),
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const pendingWrites = [];
      let aborted = false;

      busboy.on('field', (name, value) => {
        fieldValues.set(String(name), String(value));
      });

      busboy.on('file', (name, file, info = {}) => {
        if (String(name || '').trim() !== 'file') {
          file.resume();
          return;
        }
        const ext = imageExtensionFromMimeType(info.mimeType || 'image/jpeg');
        const filePath = path.join(LOCAL_IMAGE_ANALYSIS_DIR, `${uploadId}-source.${ext}`);
        createdPaths.push(filePath);
        const writePromise = pipeline(file, createWriteStream(filePath)).then(() => {
          uploadedFile = {
            filePath,
            filename: String(info.filename || ''),
            mimeType: String(info.mimeType || 'image/jpeg'),
          };
        });
        pendingWrites.push(writePromise);
      });

      busboy.once('error', reject);
      busboy.once('partsLimit', () => reject(new Error('local-image-analysis-too-many-parts')));
      busboy.once('filesLimit', () => reject(new Error('local-image-analysis-too-many-files')));
      busboy.once('fieldsLimit', () => reject(new Error('local-image-analysis-too-many-fields')));
      busboy.once('finish', async () => {
        if (aborted) return;
        try {
          await Promise.all(pendingWrites);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      req.once('aborted', () => {
        aborted = true;
        reject(new Error('local-image-analysis-aborted'));
      });

      req.pipe(busboy);
    });

    return {
      itemId: String(fieldValues.get('itemId') || '').trim(),
      name: String(fieldValues.get('name') || uploadedFile?.filename || '').trim(),
      width: Number(fieldValues.get('width') || 0) || 0,
      height: Number(fieldValues.get('height') || 0) || 0,
      sourceUrl: String(fieldValues.get('sourceUrl') || '').trim(),
      engine: String(fieldValues.get('engine') || 'auto').trim() || 'auto',
      provider: String(fieldValues.get('provider') || '').trim(),
      model: String(fieldValues.get('model') || '').trim(),
      tags: parseStringArrayField(fieldValues.get('tags')),
      smartCategories: parseStringArrayField(fieldValues.get('smartCategories')),
      inputPath: uploadedFile?.filePath || '',
      inputMimeType: uploadedFile?.mimeType || 'image/jpeg',
      cleanupPaths: createdPaths,
    };
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

async function readAssetLibraryImportMultipart(req) {
  await fs.mkdir(ASSET_LIBRARY_TEMP_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const fieldValues = new Map();
  let uploadedFile = null;
  const createdPaths = [];
  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fields: 48,
      fileSize: Number(process.env.HMDAO_ASSET_IMPORT_MAX_BYTES || 2 * 1024 * 1024 * 1024),
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const pendingWrites = [];
      let aborted = false;

      busboy.on('field', (name, value) => {
        fieldValues.set(String(name), String(value));
      });

      busboy.on('file', (name, file, info = {}) => {
        if (String(name || '').trim() !== 'file') {
          file.resume();
          return;
        }
        const ext = extensionFromMimeType(info.mimeType || 'application/octet-stream');
        const filePath = path.join(ASSET_LIBRARY_TEMP_DIR, `${uploadId}-source.${ext}`);
        createdPaths.push(filePath);
        const writePromise = pipeline(file, createWriteStream(filePath)).then(() => {
          uploadedFile = {
            filePath,
            filename: String(info.filename || ''),
            mimeType: String(info.mimeType || 'application/octet-stream'),
          };
        });
        pendingWrites.push(writePromise);
      });

      busboy.once('error', reject);
      busboy.once('partsLimit', () => reject(new Error('asset-import-too-many-parts')));
      busboy.once('filesLimit', () => reject(new Error('asset-import-too-many-files')));
      busboy.once('fieldsLimit', () => reject(new Error('asset-import-too-many-fields')));
      busboy.once('finish', async () => {
        if (aborted) return;
        try {
          await Promise.all(pendingWrites);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      req.once('aborted', () => {
        aborted = true;
        reject(new Error('asset-import-aborted'));
      });

      req.pipe(busboy);
    });

    return {
      name: String(fieldValues.get('name') || uploadedFile?.filename || '').trim(),
      folderId: String(fieldValues.get('folderId') || 'root').trim() || 'root',
      type: String(fieldValues.get('type') || '').trim(),
      tags: parseStringArrayField(fieldValues.get('tags')),
      smartCategories: parseStringArrayField(fieldValues.get('smartCategories')),
      width: Number(fieldValues.get('width') || 0) || 0,
      height: Number(fieldValues.get('height') || 0) || 0,
      duration: Number(fieldValues.get('duration') || 0) || 0,
      sourceUrl: String(fieldValues.get('sourceUrl') || uploadedFile?.filename || '').trim(),
      inputPath: uploadedFile?.filePath || '',
      inputMimeType: uploadedFile?.mimeType || 'application/octet-stream',
      originalName: String(uploadedFile?.filename || '').trim(),
      cleanupPaths: createdPaths,
    };
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

// ---- 资产库按用户硬隔离：每个用户的素材落在 baseStoragePath/{userId}/ 下 ----
function sanitizeUserIdForPath(userId) {
  const s = String(userId || '').trim().toLowerCase();
  const safe = s.replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  return safe || 'anonymous';
}
function storageDirForUser(userId, baseStoragePath) {
  return path.join(String(baseStoragePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR), sanitizeUserIdForPath(userId));
}

async function processAssetLibraryImportRequest(userId, body = {}) {
  const settings = await readAssetLibrarySettings();
  const baseStoragePath = path.resolve(String(settings.storagePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR));
  const storagePath = storageDirForUser(userId, baseStoragePath);
  const assetId = crypto.randomUUID();
  const sourceUrl = String(body.sourceUrl || '').trim();
  const inputPath = String(body.inputPath || '').trim();
  const explicitType = String(body.type || '').trim();
  const copySourceFile = Boolean(body.copySourceFile);
  const referenceSourceFile = Boolean(body.referenceSourceFile) && Boolean(inputPath);
  let sourceMimeType = String(body.inputMimeType || '').trim();
  let tempPath = inputPath;

  if (!tempPath && sourceUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Number(process.env.HMDAO_ASSET_IMPORT_TIMEOUT_MS || 120000));
    try {
      const skAuth = (process.env.HMDAO_SKETCHFAB_API_KEY || process.env.VITE_SKETCHFAB_API_KEY || '');
      const fetchHeaders = {
        Accept: '*/*',
        'User-Agent': 'DDUp Asset Import',
      };
      // 转发来源页 Referer 以绕过防盗链；源站常只对带正确 Referer 的请求返回真实媒体。
      const importReferer = String(body.pageUrl || body.referer || sourceUrl || '').trim();
      if (importReferer) {
        fetchHeaders.Referer = importReferer;
        fetchHeaders.Origin = importReferer;
      }
      if (skAuth && /sketchfab\.com\/v3\/models\/.+\/download/.test(sourceUrl)) {
        fetchHeaders.Authorization = `Bearer ${skAuth}`;
      }
      const response = await fetch(sourceUrl, {
        signal: controller.signal,
        headers: fetchHeaders,
      });
      if (!response.ok) {
        throw new Error(`asset-import-fetch-failed:${response.status}`);
      }
      sourceMimeType = sourceMimeType || String(response.headers.get('content-type') || '').trim();
      const ext = extensionFromMimeType(sourceMimeType || sourceUrl || 'application/octet-stream');
      tempPath = path.join(ASSET_LIBRARY_TEMP_DIR, `${assetId}-remote.${ext}`);
      await fs.mkdir(ASSET_LIBRARY_TEMP_DIR, { recursive: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      // 源站可能返回登录/播放器/防盗链 HTML 页面（HTTP 200）而非真实媒体。
      // 若显式要求的是音视频/图片，却拿到 HTML，应直接报错，避免存成无用素材。
      const expectedMedia = ['audio', 'video', 'image'].includes(explicitType);
      if (expectedMedia && looksLikeHtml(buffer, sourceMimeType)) {
        throw new Error('asset-import-not-media:上游返回的是网页(HTML)而非音频/视频/图片文件，通常因源站防盗链或需登录。请改用带正确来源页(Referer)的地址，或在浏览器中直接获取真实文件后本地导入。');
      }
      await fs.writeFile(tempPath, buffer);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!tempPath) {
    throw new Error('asset-import-source-missing');
  }

  const type = ['image', 'video', 'audio', 'text', 'model'].includes(explicitType)
    ? explicitType
    : inferAssetTypeFromMime(sourceMimeType, inferAssetTypeFromPath(tempPath, 'image'));
  const rawName = String(body.name || body.originalName || sourceUrl || path.basename(tempPath)).trim();
  const baseName = sanitizeAssetFileBaseName(rawName);
  const ext = path.extname(rawName).replace(/^\.+/, '') || extensionFromMimeType(sourceMimeType || tempPath || 'application/octet-stream');
  const fileName = `${assetId}-${baseName}.${String(ext || 'bin').replace(/^\.+/, '')}`;
  const tempResolvedPath = path.resolve(tempPath);
  const tempStat = await fs.stat(tempResolvedPath);
  const contentHash = await computeAssetContentHash(tempResolvedPath, {
    type,
    duration: Number(body.duration || 0) || 0,
  });
  const existingItems = await readAssetLibraryCatalog(userId);
  const duplicateMatch = referenceSourceFile
    ? (
      existingItems.find((item) => (
        String(item?.storageLabel || '').trim().toLowerCase() === 'reference'
        && String(item?.type || '') === type
        && normalizeAssetDuplicateValue(item?.filePath || '') === normalizeAssetDuplicateValue(tempResolvedPath)
      )) || null
    )
    : findDuplicateAssetLibraryItem(existingItems, {
      type,
      filePath: '',
      sourceUrl: sourceUrl || String(body.originalName || rawName || '').trim(),
      name: rawName || fileName,
      size: Number(tempStat.size || 0),
      width: Number(body.width || 0) || 0,
      height: Number(body.height || 0) || 0,
      duration: Number(body.duration || 0) || 0,
      storageLabel: 'disk',
      source: sourceUrl ? 'crawl' : 'upload',
      contentHash,
    });
  if (duplicateMatch) {
    const mergedDuplicate = mergeDuplicateAssetCandidate(duplicateMatch, {
      folderId: String(body.folderId || duplicateMatch.folderId || 'root'),
      width: Number(body.width || 0) || undefined,
      height: Number(body.height || 0) || undefined,
      duration: Number(body.duration || 0) || undefined,
      sourceUrl: sourceUrl || String(body.originalName || rawName || '').trim(),
      tags: parseStringArrayField(body.tags),
      smartCategories: parseStringArrayField(body.smartCategories),
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      contentHash,
    });
    await upsertAssetLibraryItem(userId, mergedDuplicate);
    if (!referenceSourceFile && tempResolvedPath.startsWith(path.resolve(ASSET_LIBRARY_TEMP_DIR))) {
      await fs.rm(tempResolvedPath, { force: true }).catch(() => {});
    }
    return {
      item: mergedDuplicate,
      storagePath,
      duplicate: true,
    };
  }
  let targetPath = tempResolvedPath;
  if (!referenceSourceFile) {
    await fs.mkdir(storagePath, { recursive: true });
    const targetDir = path.join(storagePath, type);
    await fs.mkdir(targetDir, { recursive: true });
    targetPath = path.join(targetDir, fileName);
    if (copySourceFile) {
      await fs.copyFile(tempPath, targetPath);
    } else {
      await fs.rename(tempPath, targetPath).catch(async () => {
        await fs.copyFile(tempPath, targetPath);
        await fs.rm(tempPath, { force: true }).catch(() => {});
      });
    }
  }
  const stat = await fs.stat(targetPath);

  const item = await upsertAssetLibraryItem(userId, {
    id: assetId,
    backendAssetId: assetId,
    name: rawName || fileName,
    type,
    thumbnail: type === 'audio' ? '' : buildAssetLibraryContentUrl(assetId),
    folderId: String(body.folderId || 'root'),
    size: Number(stat.size || 0),
    width: Number(body.width || 0) || undefined,
    height: Number(body.height || 0) || undefined,
    duration: Number(body.duration || 0) || undefined,
    tags: parseStringArrayField(body.tags),
    smartCategories: parseStringArrayField(body.smartCategories),
    sourceUrl: sourceUrl || String(body.originalName || rawName || '').trim(),
    filePath: targetPath,
    persisted: true,
    storageLabel: referenceSourceFile ? 'reference' : 'disk',
    source: referenceSourceFile ? 'upload' : (sourceUrl ? 'crawl' : 'upload'),
    contentHash,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return {
    item,
    storagePath,
    duplicate: false,
  };
}

function powershellSingleQuote(value) {
  return "'" + String(value || '').replace(/'/g, "''") + "'";
}

function shouldUsePowerShellRelayFallback(baseUrl = '', error = null) {
  const normalizedBaseUrl = String(baseUrl || '').trim().toLowerCase();
  if (!normalizedBaseUrl.includes('apimart.ai')) return false;
  const errorName = String(error?.name || '').trim().toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  const causeMessage = String(error?.cause?.message || '').toLowerCase();
  const causeCode = String(error?.cause?.code || error?.code || '').trim().toUpperCase();
  const abortedByController = errorName === 'aborterror'
    || message.includes('aborted')
    || causeMessage.includes('aborted');
  return causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    || causeCode === 'UND_ERR_CONNECT'
    || abortedByController
    || message.includes('fetch failed')
    || causeMessage.includes('connect timeout');
}

async function executePowerShellRelayRequest({
  url,
  method = 'POST',
  headers = {},
  body = {},
  timeoutMs = 90000,
}) {
  await fs.mkdir(RELAY_HTTP_TEMP_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const headersPath = path.join(RELAY_HTTP_TEMP_DIR, `${requestId}-headers.json`);
  const bodyPath = path.join(RELAY_HTTP_TEMP_DIR, `${requestId}-body.json`);
  const payloadText = typeof body === 'string' ? body : JSON.stringify(body || {});
  const normalizedMethod = String(method || 'POST').toUpperCase();
  const shouldSendJsonBody = normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD' && payloadText !== '' && payloadText !== '{}';
  await fs.writeFile(headersPath, JSON.stringify(headers || {}), 'utf8');
  await fs.writeFile(bodyPath, payloadText, 'utf8');
  const timeoutSec = Math.max(15, Math.ceil(Number(timeoutMs || 90000) / 1000));
  const invokeLine = shouldSendJsonBody
    ? `  $resp = Invoke-WebRequest -Uri ${powershellSingleQuote(url)} -Method ${powershellSingleQuote(normalizedMethod)} -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec ${timeoutSec} -ErrorAction Stop`
    : `  $resp = Invoke-WebRequest -Uri ${powershellSingleQuote(url)} -Method ${powershellSingleQuote(normalizedMethod)} -Headers $headers -TimeoutSec ${timeoutSec} -ErrorAction Stop`;
  const script = [
    `$headersJson = Get-Content -Raw -LiteralPath ${powershellSingleQuote(headersPath)} | ConvertFrom-Json`,
    '$headers = @{}',
    '$headersJson.PSObject.Properties | ForEach-Object { $headers[$_.Name] = [string]$_.Value }',
    `$body = Get-Content -Raw -LiteralPath ${powershellSingleQuote(bodyPath)}`,
    'try {',
    invokeLine,
    "  $contentType = if ($resp.Headers['Content-Type']) { [string]$resp.Headers['Content-Type'] } else { 'application/json' }",
    '  $result = @{ ok = $true; status = [int]$resp.StatusCode; contentType = $contentType; body = [string]$resp.Content }',
    '} catch {',
    '  $response = $_.Exception.Response',
    '  $statusCode = if ($response) { [int]$response.StatusCode } else { 0 }',
    "  $contentType = if ($response -and $response.Headers -and $response.Headers['Content-Type']) { [string]$response.Headers['Content-Type'] } else { 'application/json' }",
    "  $content = ''",
    '  if ($response) {',
    '    try {',
    '      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())',
    '      $content = $reader.ReadToEnd()',
    '      $reader.Dispose()',
    '    } catch {}',
    '  }',
    '  $result = @{ ok = $false; status = $statusCode; contentType = $contentType; body = $content; message = $_.Exception.Message }',
    '}',
    '$result | ConvertTo-Json -Compress -Depth 8',
  ].join('\n');
  try {
    const { stdout } = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    const parsed = JSON.parse(String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
    return {
      ok: Boolean(parsed?.ok),
      status: Number(parsed?.status || 0),
      contentType: String(parsed?.contentType || 'application/json'),
      body: String(parsed?.body || ''),
      message: String(parsed?.message || ''),
    };
  } finally {
    await Promise.allSettled([
      fs.rm(headersPath, { force: true }),
      fs.rm(bodyPath, { force: true }),
    ]);
  }
}

function isApimartAsyncGenerationRequest(baseUrl = '', endpoint = '', mode = '', payload = {}, provider = '') {
  if (!isApimartBaseUrl(baseUrl)) return false;
  if (mode !== 'image' && mode !== 'video') return false;
  const normalizedEndpoint = String(endpoint || '').trim();
  if (/\/(?:images|videos)\/generations\/?$/i.test(normalizedEndpoint)) return true;
  if (mode !== 'video') return false;
  if (!/\/video\/?$/i.test(normalizedEndpoint)) return false;
  const requestedModel = extractFirstString(payload?.model) || String(provider || '').trim();
  return Boolean(apimartVideoModelKind(requestedModel, catalogLookup));
}

async function sleepWithSignal(ms, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

async function requestJsonWithOptionalPowerShellRelay({
  baseUrl = '',
  url,
  method = 'POST',
  headers = {},
  body = undefined,
  signal,
  timeoutMs = 90000,
}) {
  const requestUrls = relayRequestUrlCandidates(baseUrl, url);
  let response;
  let lastFetchError = null;
  for (const requestUrl of requestUrls) {
    try {
      response = await fetch(requestUrl, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      break;
    } catch (fetchError) {
      lastFetchError = fetchError;
      if (!shouldUsePowerShellRelayFallback(requestUrl, fetchError) && !shouldUsePowerShellRelayFallback(baseUrl, fetchError)) {
        throw fetchError;
      }
    }
  }
  if (!response) {
    let lastFallback = null;
    for (const requestUrl of requestUrls) {
      const fallback = await executePowerShellRelayRequest({
        url: requestUrl,
        method,
        headers,
        body: body === undefined ? {} : body,
        timeoutMs,
      });
      lastFallback = fallback;
      if (!(fallback.ok || fallback.status > 0 || String(fallback.body || fallback.message || '').trim())) continue;
      let data = null;
      try {
        data = fallback.body ? JSON.parse(fallback.body) : null;
      } catch {
        data = { raw: fallback.body };
      }
      return {
        ok: fallback.ok,
        status: Number(fallback.status || 0),
        contentType: String(fallback.contentType || 'application/json'),
        data,
        fallback: true,
      };
    }
    if (lastFetchError) throw lastFetchError;
    if (lastFallback?.message) throw new Error(lastFallback.message);
    throw new Error('relay-request-failed');
  }

  const contentType = response.headers.get('content-type') || 'application/json';
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    contentType,
    data,
    fallback: false,
  };
}

function relayConnectivityCacheKey(baseUrl = '') {
  return String(baseUrl || '').trim().toLowerCase().replace(/\/$/, '');
}

async function probeRelayConnectivity(baseUrl = '', timeoutMs = 8000) {
  const normalizedBaseUrl = normalizeRelayEndpointInput(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      code: 'missing-base-url',
      message: '当前 provider 没有可用 Base URL',
    };
  }

  const cacheKey = relayConnectivityCacheKey(normalizedBaseUrl);
  const now = Date.now();
  const cached = RELAY_CONNECTIVITY_CACHE.get(cacheKey);
  if (cached && Number(cached.expiresAt || 0) > now) {
    return cached.value;
  }

  const candidates = relayModelsEndpointCandidates(normalizedBaseUrl);
  let lastFailure = {
    ok: false,
    code: 'connectivity-check-failed',
    message: `Unable to reach ${normalizedBaseUrl}.`,
  };

  for (const candidateUrl of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(candidateUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const result = {
        ok: true,
        url: candidateUrl,
        status: Number(response.status || 0),
      };
      RELAY_CONNECTIVITY_CACHE.set(cacheKey, {
        value: result,
        expiresAt: now + RELAY_CONNECTIVITY_SUCCESS_TTL_MS,
      });
      return result;
    } catch (error) {
      clearTimeout(timer);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const timeoutLike = error?.name === 'AbortError' || /aborted/i.test(rawMessage);
      const message = timeoutLike
        ? 'Connection to ' + candidateUrl + ' timed out. Check whether the current network can reach that endpoint.'
        : rawMessage;
      lastFailure = {
        ok: false,
        url: candidateUrl,
        code: timeoutLike
          ? 'CONNECT_TIMEOUT'
          : (String(error?.cause?.code || error?.code || '').trim().toUpperCase() || 'fetch-failed'),
        message,
      };
      if (!shouldUsePowerShellRelayFallback(candidateUrl, error) && !shouldUsePowerShellRelayFallback(normalizedBaseUrl, error)) {
        continue;
      }
      const fallback = await executePowerShellRelayRequest({
        url: candidateUrl,
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        timeoutMs,
      });
      if (Number(fallback.status || 0) > 0) {
        const result = {
          ok: true,
          url: candidateUrl,
          status: Number(fallback.status || 0),
          fallback: true,
        };
        RELAY_CONNECTIVITY_CACHE.set(cacheKey, {
          value: result,
          expiresAt: now + RELAY_CONNECTIVITY_SUCCESS_TTL_MS,
        });
        return result;
      }
      lastFailure = {
        ok: false,
        url: candidateUrl,
        code: String(fallback.message || lastFailure.code || 'powershell-fallback-failed').trim(),
        message: String(fallback.message || lastFailure.message || `Unable to reach ${candidateUrl}.`).trim(),
      };
    }
  }

  RELAY_CONNECTIVITY_CACHE.set(cacheKey, {
    value: lastFailure,
    expiresAt: now + RELAY_CONNECTIVITY_FAILURE_TTL_MS,
  });
  return lastFailure;
}

async function executePowerShellRelayMultipartUpload({
  url,
  headers = {},
  filePath,
  timeoutMs = 90000,
}) {
  await fs.mkdir(RELAY_HTTP_TEMP_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const headersPath = path.join(RELAY_HTTP_TEMP_DIR, `${requestId}-multipart-headers.json`);
  await fs.writeFile(headersPath, JSON.stringify(headers || {}), 'utf8');
  const timeoutSec = Math.max(15, Math.ceil(Number(timeoutMs || 90000) / 1000));
  const script = [
    'Add-Type -AssemblyName System.Net.Http',
    `$headersJson = Get-Content -Raw -LiteralPath ${powershellSingleQuote(headersPath)} | ConvertFrom-Json`,
    `$filePath = ${powershellSingleQuote(filePath)}`,
    `$fileName = [System.IO.Path]::GetFileName($filePath)`,
    '$bytes = [System.IO.File]::ReadAllBytes($filePath)',
    '$mime = [string][System.Web.MimeMapping]::GetMimeMapping($fileName)',
    '$client = [System.Net.Http.HttpClient]::new()',
    `$client.Timeout = [TimeSpan]::FromSeconds(${timeoutSec})`,
    '$headersJson.PSObject.Properties | ForEach-Object { [void]$client.DefaultRequestHeaders.TryAddWithoutValidation($_.Name, [string]$_.Value) }',
    '$form = [System.Net.Http.MultipartFormDataContent]::new()',
    '$fileContent = [System.Net.Http.ByteArrayContent]::new($bytes)',
    '$fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($mime)',
    "$form.Add($fileContent, 'file', $fileName)",
    'try {',
    `  $resp = $client.PostAsync(${powershellSingleQuote(url)}, $form).GetAwaiter().GetResult()`,
    '  $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()',
    "  $contentType = if ($resp.Content.Headers.ContentType) { [string]$resp.Content.Headers.ContentType } else { 'application/json' }",
    '  $result = @{ ok = $resp.IsSuccessStatusCode; status = [int]$resp.StatusCode; contentType = $contentType; body = $body }',
    '} catch {',
    '  $result = @{ ok = $false; status = 0; contentType = "application/json"; body = ""; message = $_.Exception.Message }',
    '} finally {',
    '  $form.Dispose()',
    '  $fileContent.Dispose()',
    '  $client.Dispose()',
    '}',
    '$result | ConvertTo-Json -Compress -Depth 8',
  ];
  try {
    const { stdout } = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script.join('\n')]);
    const parsed = JSON.parse(String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
    return {
      ok: Boolean(parsed?.ok),
      status: Number(parsed?.status || 0),
      contentType: String(parsed?.contentType || 'application/json'),
      body: String(parsed?.body || ''),
      message: String(parsed?.message || ''),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: 'application/json',
      body: '',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.rm(headersPath, { force: true }).catch(() => {});
  }
}

async function resolveManagedLocalMediaFile(value = '', kind = '') {
  const managedPath = extractManagedLocalRoutePath(value);
  if (!managedPath) return null;

  if (managedPath.startsWith('/api/assets/content/')) {
    const assetId = sanitizeLocalAssetId(managedPath.slice('/api/assets/content/'.length).split(/[?#]/, 1)[0]);
    if (!assetId) return null;
    const item = await findAssetLibraryItem(assetId);
    if (!item?.filePath) return null;
    return {
      filePath: path.resolve(String(item.filePath || '').trim()),
      mimeType: mediaMimeTypeFromExtension(String(item.filePath || ''), inferMediaContentType(String(item.filePath || ''), '', kind)),
      originalName: String(item.name || `${assetId}`),
      cleanupPaths: [],
    };
  }

  const routeMap = [
    ['/api/local-video/result/', LOCAL_VIDEO_RESULT_DIR, 'video'],
    ['/api/local-audio/result/', LOCAL_AUDIO_RESULT_DIR, 'audio'],
    ['/api/local-post/result/', LOCAL_POST_RESULT_DIR, kind || 'video'],
  ];
  for (const [prefix, baseDir, inferredKind] of routeMap) {
    if (!managedPath.startsWith(prefix)) continue;
    const assetId = sanitizeLocalAssetId(managedPath.slice(prefix.length).split(/[?#]/, 1)[0]);
    if (!assetId) return null;
    const filePath = path.join(baseDir, assetId);
    return {
      filePath,
      mimeType: mediaMimeTypeFromExtension(filePath, inferMediaContentType(filePath, '', inferredKind)),
      originalName: path.basename(filePath),
      cleanupPaths: [],
    };
  }

  return null;
}

async function materializeMediaSourceToLocalFile(value = '', kind = '') {
  const source = String(value || '').trim();
  if (!source) return null;

  const inline = parseInlineDataUrl(source);
  if (inline?.buffer?.length) {
    const extension = extensionFromMimeType(inline.mimeType || (kind === 'video' ? 'video/mp4' : 'image/png'));
    const tempPath = path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.${extension}`);
    await fs.mkdir(APIMART_CONDITIONING_DIR, { recursive: true });
    await fs.writeFile(tempPath, inline.buffer);
    return {
      filePath: tempPath,
      mimeType: inline.mimeType || (kind === 'video' ? 'video/mp4' : 'image/png'),
      originalName: path.basename(tempPath),
      cleanupPaths: [tempPath],
    };
  }

  const managed = await resolveManagedLocalMediaFile(source, kind);
  if (managed) return managed;

  if (/^file:\/\//i.test(source)) {
    const filePath = fileURLToPath(source);
    return {
      filePath,
      mimeType: mediaMimeTypeFromExtension(filePath, inferMediaContentType(filePath, '', kind)),
      originalName: path.basename(filePath),
      cleanupPaths: [],
    };
  }

  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\')) {
    return {
      filePath: path.resolve(source),
      mimeType: mediaMimeTypeFromExtension(source, inferMediaContentType(source, '', kind)),
      originalName: path.basename(source),
      cleanupPaths: [],
    };
  }

  if (/^https?:\/\//i.test(source)) {
    const remote = await downloadRemoteMediaBuffer(source);
    const extension = extensionFromMimeType(remote.mimeType || source || (kind === 'video' ? 'video/mp4' : 'image/png'));
    const tempPath = path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.${extension}`);
    await fs.mkdir(APIMART_CONDITIONING_DIR, { recursive: true });
    await fs.writeFile(tempPath, remote.bytes);
    return {
      filePath: tempPath,
      mimeType: remote.mimeType || mediaMimeTypeFromExtension(source, inferMediaContentType(source, '', kind)),
      originalName: path.basename(new URL(source).pathname) || path.basename(tempPath),
      cleanupPaths: [tempPath],
    };
  }

  return null;
}

function shouldUploadApimartImageConditioningValue(value = '') {
  const source = String(value || '').trim();
  if (!source) return false;
  if (source.startsWith('data:image/')) return true;
  if (source.startsWith('/api/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\') || /^file:\/\//i.test(source)) return true;
  if (isManagedPublicRelayAssetUrl(source)) return true;
  try {
    const url = new URL(source);
    return isPrivateOrLocalHostname(url.hostname) || isTemporaryTunnelHost(url.hostname);
  } catch {
    return false;
  }
}

async function transcodeVideoToMp4(inputPath, outputPath, minimumDurationSeconds = 0) {
  const sourceMeta = await probeVideoFile(inputPath).catch(() => ({ duration: 0 }));
  const padSeconds = Math.max(0, Number(minimumDurationSeconds || 0) - Number(sourceMeta?.duration || 0));
  const videoFilters = ['scale=trunc(iw/2)*2:trunc(ih/2)*2'];
  if (padSeconds > 0.01) {
    videoFilters.push(`tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)}`);
  }
  const videoEncoder = await resolvePreferredMp4VideoEncoder();
  const videoEncoderArgs = videoEncoder === 'mpeg4'
    ? ['-c:v', 'mpeg4', '-q:v', '2']
    : ['-c:v', videoEncoder, '-b:v', '4M'];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    videoFilters.join(','),
    ...videoEncoderArgs,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    outputPath,
  ]);
  return outputPath;
}

function tmpfilesDirectDownloadUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.hostname !== 'tmpfiles.org') return raw;
    if (url.pathname.startsWith('/dl/')) return raw;
    url.pathname = `/dl${url.pathname}`;
    return url.toString();
  } catch {
    return raw;
  }
}

async function uploadTmpfilesPublicAsset(filePath, timeoutMs = 90000) {
  const upload = await executePowerShellRelayMultipartUpload({
    url: 'https://tmpfiles.org/api/v1/upload',
    headers: {
      Accept: 'application/json',
    },
    filePath,
    timeoutMs,
  });
  let data = null;
  try {
    data = upload.body ? JSON.parse(upload.body) : null;
  } catch {
    data = { raw: upload.body };
  }
  if (!upload.ok) {
    const message = extractFirstString(data?.message) || upload.message || `tmpfiles upload failed with HTTP ${upload.status}.`;
    throw new Error(message);
  }
  const publishedUrl = extractFirstString(data?.data?.url) || extractFirstString(data?.url);
  if (!publishedUrl) {
    throw new Error('tmpfiles upload succeeded without a public URL.');
  }
  return tmpfilesDirectDownloadUrl(publishedUrl);
}

async function ensureStablePublicVideoUrl(value = '', timeoutMs = 90000, userId) {
  const source = String(value || '').trim();
  if (!source) return source;
  if (isPublicRemoteMediaUrl(source) && /\.mp4(?:[?#]|$)/i.test(source)) {
    try {
      const url = new URL(source);
      if (!isManagedPublicRelayAssetUrl(source) && !isTemporaryTunnelHost(url.hostname)) {
        return source;
      }
    } catch {
      return source;
    }
  }

  const materialized = await materializeMediaSourceToLocalFile(source, 'video');
  if (!materialized?.filePath) return source;

  const cleanupPaths = [...(materialized.cleanupPaths || [])];
  try {
    const inputPath = path.resolve(materialized.filePath);
    const sourceMeta = await probeVideoFile(inputPath).catch(() => ({ duration: 0 }));
    const durationTooShort = Number(sourceMeta?.duration || 0) > 0 && Number(sourceMeta.duration) < 3;
    const alreadyMp4 = /\.mp4$/i.test(inputPath) && String(materialized.mimeType || '').toLowerCase().includes('video/mp4');
    const publishPath = alreadyMp4
      ? (durationTooShort ? path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.mp4`) : inputPath)
      : path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.mp4`);
    if (!alreadyMp4 || durationTooShort) {
      await transcodeVideoToMp4(inputPath, publishPath, 3);
      cleanupPaths.push(publishPath);
    }
    if (PUBLIC_MEDIA_BASE_URL) {
      const sourceName = String(materialized.originalName || path.basename(inputPath)).trim();
      const publishedNameBase = path.basename(sourceName || crypto.randomUUID(), path.extname(sourceName || ''));
      const publishedName = `${publishedNameBase || crypto.randomUUID()}.mp4`;
      const imported = await processAssetLibraryImportRequest(userId, {
        name: publishedName,
        originalName: publishedName,
        type: 'video',
        sourceUrl: source || sourceName || publishedName,
        inputPath: publishPath,
        inputMimeType: 'video/mp4',
        duration: Math.max(3, Number(sourceMeta?.duration || 0)),
        copySourceFile: true,
      });
      const publishedUrl = materializePublicRelayMediaUrl(
        buildAssetLibraryContentUrl(imported?.item?.id || imported?.item?.backendAssetId || ''),
      );
      if (isPublicRemoteMediaUrl(publishedUrl)) {
        return publishedUrl;
      }
    }
    return await uploadTmpfilesPublicAsset(publishPath, timeoutMs);
  } finally {
    await Promise.all(cleanupPaths.map((entry) => fs.rm(entry, { force: true }).catch(() => {})));
  }
}

async function uploadApimartImageAsset({
  baseUrl,
  apiKey,
  value,
  timeoutMs = 90000,
  signal,
}) {
  const source = String(value || '').trim();
  if (!source || !shouldUploadApimartImageConditioningValue(source)) return source;
  const materialized = await materializeMediaSourceToLocalFile(source, 'image');
  if (!materialized?.filePath) return source;
  try {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    const uploadUrls = relayRequestUrlCandidates(baseUrl, `${baseUrl}/uploads/images`);
    let lastError = null;
    for (const uploadUrl of uploadUrls) {
      try {
        const bytes = await fs.readFile(materialized.filePath);
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: materialized.mimeType || 'image/png' }), path.basename(materialized.filePath));
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers,
          body: form,
          signal,
        });
        const contentType = response.headers.get('content-type') || 'application/json';
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        if (!response.ok) {
          const message = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || `Image upload failed with HTTP ${response.status}.`;
          throw Object.assign(new Error(message), { status: response.status, payload: data });
        }
        return extractFirstString(data?.data?.url) || extractFirstString(data?.url) || source;
      } catch (error) {
        lastError = error;
        // APIMart /uploads/images 多数情况不可用 → 不阻止 fallback
      }
    }
    // 直接走 tmpfiles.org 兜底（与视频上传完全相同）
    try {
      const tmpfilesUrl = await uploadTmpfilesPublicAsset(materialized.filePath, timeoutMs);
      if (tmpfilesUrl && /^https?:\/\//i.test(tmpfilesUrl)) {
        return tmpfilesUrl;
      }
    } catch (tmpfilesError) {
      // tmpfiles.org 也不可用，继续回退
    }
    // 所有上传路径都失败 — 回退到原始 URL（外部服务可能可以直接访问）
    return source;
  } finally {
    await Promise.all((materialized.cleanupPaths || []).map((entry) => fs.rm(entry, { force: true }).catch(() => {})));
  }
}

async function materializeApimartImageConditioningPayload(payload = {}, baseUrl = '', apiKey = '', timeoutMs = 90000, signal) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  const sourceMediaType = String(next.source_media_type || payload.source_media_type || '').trim().toLowerCase();
  const imageUrlFields = [
    'image',
    'image_url',
    'reference_image',
    'reference_image_url',
    'first_frame_image',
    'first_frame_image_url',
    'last_frame_image',
    'last_frame_image_url',
  ];
  if (sourceMediaType !== 'video') {
    imageUrlFields.push('source_url');
  }
  for (const field of imageUrlFields) {
    if (typeof next[field] === 'string') {
      next[field] = await uploadApimartImageAsset({
        baseUrl,
        apiKey,
        value: next[field],
        timeoutMs,
        signal,
      });
    }
  }
  if (Array.isArray(next.image_urls)) {
    next.image_urls = await Promise.all(next.image_urls.map((item) => (
      typeof item === 'string'
        ? uploadApimartImageAsset({ baseUrl, apiKey, value: item, timeoutMs, signal })
        : item
    )));
  }
  if (Array.isArray(next.image_with_roles)) {
    next.image_with_roles = await Promise.all(next.image_with_roles.map(async (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const entry = { ...item };
      const sharedImageValue = typeof entry.url === 'string' && entry.url.startsWith('data:image/')
        ? entry.url
        : typeof entry.image_url === 'string' && entry.image_url.startsWith('data:image/')
          ? entry.image_url
          : typeof entry.image === 'string' && entry.image.startsWith('data:image/')
            ? entry.image
            : '';
      if (sharedImageValue) {
        const uploaded = await uploadApimartImageAsset({
          baseUrl,
          apiKey,
          value: sharedImageValue,
          timeoutMs,
          signal,
        });
        entry.url = uploaded;
        entry.image_url = uploaded;
        if (typeof entry.image === 'string') entry.image = uploaded;
      } else {
        for (const field of ['url', 'image_url', 'image']) {
          if (typeof entry[field] === 'string') {
            const uploaded = await uploadApimartImageAsset({
              baseUrl,
              apiKey,
              value: entry[field],
              timeoutMs,
              signal,
            });
            entry[field] = uploaded;
          }
        }
      }
      if (!entry.url && typeof entry.image_url === 'string') entry.url = entry.image_url;
      if (!entry.image_url && typeof entry.url === 'string') entry.image_url = entry.url;
      return entry;
    }));
  }
  return next;
}

async function materializeApimartVideoConditioningPayload(payload = {}, timeoutMs = 90000, userId) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  const videoUrlFields = ['source_url', 'reference_video_url', 'video_url'];
  for (const field of videoUrlFields) {
    if (typeof next[field] === 'string') {
      next[field] = await ensureStablePublicVideoUrl(next[field], timeoutMs, userId);
    }
  }
  if (Array.isArray(next.video_urls)) {
    next.video_urls = await Promise.all(next.video_urls.map((item) => (
      typeof item === 'string' ? ensureStablePublicVideoUrl(item, timeoutMs, userId) : item
    )));
  }
  if (Array.isArray(next.video_list)) {
    next.video_list = await Promise.all(next.video_list.map(async (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      if (typeof item.video_url !== 'string') return item;
      return {
        ...item,
        video_url: await ensureStablePublicVideoUrl(item.video_url, timeoutMs, userId),
      };
    }));
  }
  return next;
}

function resolvePublicMediaBaseUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (isPrivateOrLocalHostname(url.hostname)) return '';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return String(url.toString() || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

const PUBLIC_MEDIA_BASE_URL = resolvePublicMediaBaseUrl(
  process.env.HMDAO_PUBLIC_BASE_URL || process.env.HMDAO_REAL_PUBLIC_BASE_URL || '',
);

function materializePublicRelayMediaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw || !PUBLIC_MEDIA_BASE_URL) return raw;
  if (
    raw.startsWith('/api/assets/content/')
    || raw.startsWith('/api/media-proxy?')
    || raw.startsWith('/api/local-video/result/')
    || raw.startsWith('/api/local-post/result/')
  ) {
    return new URL(raw, `${PUBLIC_MEDIA_BASE_URL}/`).toString();
  }
  try {
    const url = new URL(raw);
    if (
      isPrivateOrLocalHostname(url.hostname)
      && (
        url.pathname.startsWith('/api/assets/content/')
        || url.pathname.startsWith('/api/media-proxy')
        || url.pathname.startsWith('/api/local-video/result/')
        || url.pathname.startsWith('/api/local-post/result/')
      )
    ) {
      return new URL(`${url.pathname}${url.search}`, `${PUBLIC_MEDIA_BASE_URL}/`).toString();
    }
  } catch {
    return raw;
  }
  return raw;
}

function materializePublicRelayPayload(payload = {}) {
  if (!PUBLIC_MEDIA_BASE_URL || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const next = { ...payload };
  for (const field of ['source_url', 'reference_video_url', 'image_url', 'reference_image_url', 'first_frame_url', 'last_frame_url']) {
    if (typeof next[field] === 'string') {
      next[field] = materializePublicRelayMediaUrl(next[field]);
    }
  }
  if (Array.isArray(next.video_urls)) {
    next.video_urls = next.video_urls.map((item) => (
      typeof item === 'string' ? materializePublicRelayMediaUrl(item) : item
    ));
  }
  if (Array.isArray(next.image_urls)) {
    next.image_urls = next.image_urls.map((item) => (
      typeof item === 'string' ? materializePublicRelayMediaUrl(item) : item
    ));
  }
  if (Array.isArray(next.video_list)) {
    next.video_list = next.video_list.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      if (typeof item.video_url !== 'string') return item;
      return {
        ...item,
        video_url: materializePublicRelayMediaUrl(item.video_url),
      };
    });
  }
  if (Array.isArray(next.image_with_roles)) {
    next.image_with_roles = next.image_with_roles.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const mapped = { ...item };
      for (const field of ['url', 'image_url', 'image']) {
        if (typeof mapped[field] === 'string') {
          mapped[field] = materializePublicRelayMediaUrl(mapped[field]);
        }
      }
      return mapped;
    });
  }
  for (const field of ['primary_assets', 'reference_assets']) {
    if (!Array.isArray(next[field])) continue;
    next[field] = next[field].map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const mapped = { ...item };
      if (typeof mapped.url === 'string') {
        mapped.url = materializePublicRelayMediaUrl(mapped.url);
      }
      for (const nestedField of ['image_url', 'video_url', 'thumbnail']) {
        if (typeof mapped[nestedField] === 'string') {
          mapped[nestedField] = materializePublicRelayMediaUrl(mapped[nestedField]);
        }
      }
      return mapped;
    });
  }
  return next;
}

// P0.4：云端 provider（fal/replicate/siliconflow 等）无法访问本地 /api/assets/content/<id>
// 相对路径或 localhost URL。派发前把这类"仅本地可达"的媒体引用转换为：
//   1) 公网 tunnel URL（配置了 PUBLIC_MEDIA_BASE_URL 时，零拷贝）；
//   2) 否则内联为 data: URL（读本地字节 base64，带大小上限防 OOM）。
const CLOUD_INLINE_IMAGE_MAX_BYTES = 24 * 1024 * 1024;
const CLOUD_INLINE_VIDEO_MAX_BYTES = 48 * 1024 * 1024;

async function inlineLocalMediaReferenceForCloud(value = '', kind = 'image') {
  const source = String(value || '').trim();
  if (!source || !isLocalOnlyMediaReference(source)) return source;

  if (PUBLIC_MEDIA_BASE_URL) {
    const publicUrl = materializePublicRelayMediaUrl(source);
    if (publicUrl && publicUrl !== source && /^https?:\/\//i.test(publicUrl)) {
      try {
        if (!isPrivateOrLocalHostname(new URL(publicUrl).hostname)) return publicUrl;
      } catch {
        // fall through to inline path
      }
    }
  }

  let materialized = null;
  try {
    materialized = await materializeMediaSourceToLocalFile(source, kind);
    if (!materialized?.filePath || !(await fileExists(materialized.filePath))) return source;
    const stat = await fs.stat(materialized.filePath);
    const maxBytes = kind === 'video' ? CLOUD_INLINE_VIDEO_MAX_BYTES : CLOUD_INLINE_IMAGE_MAX_BYTES;
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return source;
    const bytes = await fs.readFile(materialized.filePath);
    const mimeType = materialized.mimeType || (kind === 'video' ? 'video/mp4' : 'image/png');
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
  } catch {
    return source;
  } finally {
    for (const cleanupPath of materialized?.cleanupPaths || []) {
      await fs.unlink(cleanupPath).catch(() => {});
    }
  }
}

const CLOUD_CONDITIONING_FIELD_KINDS = {
  source_url: '',
  image_url: 'image',
  image: 'image',
  first_frame_url: 'image',
  last_frame_url: 'image',
  first_frame_image_url: 'image',
  last_frame_image_url: 'image',
  first_frame_image: 'image',
  last_frame_image: 'image',
  reference_image_url: 'image',
  reference_image: 'image',
  reference_video_url: 'video',
  reference_video: 'video',
};

async function inlineCloudConditioningMedia(payload = {}, mode = 'image') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const next = { ...payload };
  const defaultKind = String(mode || '').toLowerCase() === 'video' ? 'video' : 'image';

  for (const [field, fieldKind] of Object.entries(CLOUD_CONDITIONING_FIELD_KINDS)) {
    if (typeof next[field] !== 'string' || !next[field].trim()) continue;
    next[field] = await inlineLocalMediaReferenceForCloud(next[field], fieldKind || defaultKind);
  }
  for (const [field, kind] of [['image_urls', 'image'], ['video_urls', 'video']]) {
    if (!Array.isArray(next[field])) continue;
    next[field] = await Promise.all(next[field].map((item) => (
      typeof item === 'string' ? inlineLocalMediaReferenceForCloud(item, kind) : Promise.resolve(item)
    )));
  }
  if (next.input && typeof next.input === 'object' && !Array.isArray(next.input)) {
    next.input = await inlineCloudConditioningMedia(next.input, mode);
  }
  return next;
}

function canMaterializeApimartStableVideoSource(value = '') {
  const source = String(value || '').trim();
  if (!source) return false;
  if (isPublicRemoteMediaUrl(source)) return true;
  if (Boolean(parseInlineDataUrl(source)?.buffer?.length)) return true;
  if (extractManagedLocalRoutePath(source)) return true;
  if (/^file:\/\//i.test(source)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\')) return true;
  try {
    const url = new URL(source);
    if (isManagedPublicRelayAssetUrl(source)) return true;
    return isPrivateOrLocalHostname(url.hostname) || isTemporaryTunnelHost(url.hostname);
  } catch {
    return false;
  }
}
function buildApimartAsyncRequestConstraint({
  provider,
  mode,
  rawPayload = {},
  payload = {},
}) {
  if (String(mode || '').trim().toLowerCase() !== 'video') return null;
  const requestedModel = extractFirstString(payload?.model) || extractFirstString(rawPayload?.model) || provider;
  const model = shouldRouteApimartVideoEditToHappyhorse(rawPayload || {}, payload || {}, catalogLookup)
    ? 'happyhorse-1.0'
    : requestedModel;
  const modelKind = apimartVideoModelKind(model || provider, catalogLookup);
  if (!isApimartKlingVideoModelKind(modelKind)) return null;

  const sourceMediaType = String(rawPayload?.source_media_type || payload?.source_media_type || '').trim().toLowerCase();
  if (sourceMediaType !== 'video') return null;

  const primaryVideoUrl = extractFirstString(payload?.source_url)
    || extractFirstString(rawPayload?.source_url)
    || extractFirstString(payload?.reference_video_url)
    || extractFirstString(rawPayload?.reference_video_url)
    || extractFirstString(Array.isArray(payload?.video_urls) ? payload.video_urls[0] : '')
    || extractFirstString(Array.isArray(payload?.video_list) ? payload.video_list[0]?.video_url : '');

  const diagnosticUrls = uniqueStrings([
    extractFirstString(payload?.source_url),
    extractFirstString(rawPayload?.source_url),
    extractFirstString(payload?.reference_video_url),
    extractFirstString(rawPayload?.reference_video_url),
    ...(Array.isArray(payload?.video_urls) ? payload.video_urls.map((item) => extractFirstString(item)) : []),
    ...(Array.isArray(payload?.video_list) ? payload.video_list.map((item) => extractFirstString(item?.video_url)) : []),
  ].filter(Boolean));

  if (!primaryVideoUrl) {
    return {
      category: 'request',
      code: 'apimart-kling-source-video-missing',
      message: 'APIMart/Kling 视频请求缺少可用的 source/reference video URL，当前不会发起真实上游请求',
      detail: {
        provider,
        mode,
        modelKind,
        sourceMediaType,
        diagnosticUrls,
      },
    };
  }

  if (canMaterializeApimartStableVideoSource(primaryVideoUrl)) return null;

  return {
    category: 'request',
    code: 'apimart-kling-source-video-public-url-required',
    message: 'APIMart/Kling 的 source video 只支持公网可访问 video URL。当前仍是本地句柄、data URL、文本 URL 或 localhost/局域网地址，已在请求层拦截以避免浪费真实生成次数',
    detail: {
      provider,
      mode,
      modelKind,
      sourceMediaType,
      primaryVideoUrl,
      diagnosticUrls,
    },
  };
}

function normalizeApimartAsyncGenerationPayload({
  provider,
  mode,
  endpoint,
  rawPayload = {},
  payload = {},
}) {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (mode === 'image' && /\/images\/generations\/?$/i.test(normalizedEndpoint)) {
    const imageRoleEntries = buildApimartImageRoleEntries(rawPayload, payload);
    const orderedImageUrls = buildApimartOrderedImageUrls(imageRoleEntries);
    const model = extractFirstString(payload.model) || extractFirstString(rawPayload.model);
    const modelKind = apimartImageModelKind(model || provider, catalogLookup);
    const prompt = buildApimartImagePromptContract(
      extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      imageRoleEntries,
      rawPayload?.conditioning_strategy?.operation || payload?.conditioning_strategy?.operation || '',
    );
    const count = Number(payload.n ?? payload.count ?? rawPayload.n ?? rawPayload.count);
    const explicitNegativePrompt = extractFirstString(payload.negative_prompt) || extractFirstString(rawPayload.negative_prompt);

    return compactObject({
      model,
      prompt,
      size: apimartImageSize({ ...rawPayload, ...payload }),
      resolution: apimartImageResolution({ ...rawPayload, ...payload }, modelKind),
      n: Number.isFinite(count) ? Math.max(1, Math.min(modelKind === 'qwen-image' ? 6 : 16, Math.round(count))) : undefined,
      negative_prompt: explicitNegativePrompt || (isStrictImageSubjectSwapOperation(rawPayload?.conditioning_strategy?.operation || payload?.conditioning_strategy?.operation || '')
        ? 'people, person, woman, man, portrait, selfie, human face, character'
        : undefined),
      image_urls: orderedImageUrls.length ? orderedImageUrls : undefined,
      official_fallback: typeof payload.official_fallback === 'boolean'
        ? payload.official_fallback
        : typeof rawPayload.official_fallback === 'boolean'
          ? rawPayload.official_fallback
          : undefined,
    });
  }

  if (mode !== 'video' || !/\/videos\/generations\/?$/i.test(normalizedEndpoint)) {
    return payload;
  }

  const imageRoleEntries = buildApimartImageRoleEntries(rawPayload, payload);
  const videoRoleEntries = buildApimartVideoRoleEntries(rawPayload, payload);
  const imageUrls = uniqueStrings(imageRoleEntries.map((item) => extractFirstString(item.url)).filter(Boolean));
  const videoUrls = uniqueStrings(videoRoleEntries.map((item) => extractFirstString(item.url)).filter(Boolean));
  const audioUrls = buildApimartAudioUrls(rawPayload);
  const sourceMediaType = String(rawPayload.source_media_type || payload.source_media_type || '').trim().toLowerCase();
  const requestedModel = extractFirstString(payload.model) || extractFirstString(rawPayload.model);
  const useHappyhorseVideoEditRoute = shouldRouteApimartVideoEditToHappyhorse(rawPayload, payload, catalogLookup);
  const model = useHappyhorseVideoEditRoute ? 'happyhorse-1.0' : requestedModel;
  const modelKind = apimartVideoModelKind(model || provider, catalogLookup);
  const normalizedModel = normalizeCatalogIdentifier(model || '');
  const firstFrameImage = extractFirstString(payload.first_frame_url)
    || imageRoleEntries.find((item) => item.role === 'first_frame')?.url
    || imageRoleEntries.find((item) => item.role === 'composition')?.url
    || '';
  const lastFrameImage = extractFirstString(payload.last_frame_url)
    || imageRoleEntries.find((item) => item.role === 'last_frame')?.url
    || '';
  const subjectReferenceImage = imageRoleEntries.find((item) => item.role === 'subject')?.url
    || imageRoleEntries.find((item) => item.role === 'style')?.url
    || extractFirstString(payload.reference_image_url)
    || '';
  const referenceVideo = videoRoleEntries.find((item) => item.role === 'motion')?.url
    || extractFirstString(payload.reference_video_url)
    || '';
  const durationMin = isApimartKlingVideoModelKind(modelKind) ? 3 : 1;
  const durationMax = isApimartKlingVideoModelKind(modelKind) ? 15 : 30;
  const duration = Number.isFinite(Number(payload.duration))
    ? Math.max(durationMin, Math.min(durationMax, Math.round(Number(payload.duration))))
    : 5;
  const resolution = apimartVideoSize({ ...rawPayload, ...payload });
  const aspectRatio = apimartVideoAspectRatio({ ...rawPayload, ...payload });
  const referenceStrength = Number(rawPayload.reference_weight || rawPayload.consistency_strength || payload.reference_weight || payload.consistency_strength);
  const generateAudio = Boolean(audioUrls.length || rawPayload.generate_audio || payload.generate_audio || rawPayload.audio || payload.audio);

  const common = compactObject({
    model,
    prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
    duration,
    aspect_ratio: aspectRatio,
    seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
    negative_prompt: extractFirstString(payload.negative_prompt),
    generate_audio: generateAudio,
    image_urls: imageUrls.length ? imageUrls : undefined,
    video_urls: videoUrls.length ? videoUrls : undefined,
    audio_urls: audioUrls.length ? audioUrls : undefined,
    reference_strength: Number.isFinite(referenceStrength) ? Math.max(0.05, Math.min(1, referenceStrength > 1 ? referenceStrength / 100 : referenceStrength)) : undefined,
  });

  if (modelKind === 'happyhorse') {
    const primaryVideoUrl = sourceMediaType === 'video'
      ? extractFirstString(payload.source_url) || videoUrls[0] || referenceVideo
      : '';
    return compactObject({
      model,
      prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      duration,
      resolution,
      aspect_ratio: aspectRatio,
      seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
      negative_prompt: extractFirstString(payload.negative_prompt),
      prompt_optimizer: typeof payload.prompt_optimizer === 'boolean'
        ? payload.prompt_optimizer
        : typeof rawPayload.prompt_optimizer === 'boolean'
          ? rawPayload.prompt_optimizer
          : undefined,
      camera_fixed: typeof payload.camera_fixed === 'boolean'
        ? payload.camera_fixed
        : typeof rawPayload.camera_fixed === 'boolean'
          ? rawPayload.camera_fixed
          : sourceMediaType === 'video'
            ? true
            : undefined,
      image_url: sourceMediaType === 'video' ? undefined : firstFrameImage || undefined,
      image_urls: imageUrls.length ? imageUrls.slice(0, 5) : undefined,
      video_url: primaryVideoUrl || undefined,
    });
  }

  if (modelKind === 'seedance-v2') {
    // APIMart doubao-seedance-2.0 合约（参考 docs.apimart.ai）：
    //   - 不支持 negative_prompt
    //   - 首帧/尾帧/参考人像 应在 image_with_roles[] 数组中（{url, role: first_frame|last_frame|reference_image}）
    //   - image_urls 与 image_with_roles 互斥
    //   - 使用 image_with_roles 时 video_urls 和 audio_urls 不可用
    //   - video_urls: 最多 3 个，1.8s-15.2s，480P-720P
    const hasFrameImage = sourceMediaType !== 'video' && (firstFrameImage || lastFrameImage);
    const useImageWithRoles = hasFrameImage; // 有首尾帧则用 image_with_roles 形式

    const imageWithRoles = [];
    if (firstFrameImage) imageWithRoles.push({ url: firstFrameImage, role: 'first_frame' });
    if (lastFrameImage)  imageWithRoles.push({ url: lastFrameImage,  role: 'last_frame' });
    // 把 reference role 的人物参考放进 image_with_roles（reference_image）
    for (const entry of imageRoleEntries) {
      if (entry.role === 'subject' || entry.role === 'style' || entry.role === 'composition' || entry.role === 'lighting') {
        if (!imageWithRoles.some((e) => e.url === entry.url)) {
          imageWithRoles.push({ url: entry.url, role: 'reference_image' });
        }
      }
    }

    // 互斥规则：使用 image_with_roles 时不能同时用 video_urls 和 audio_urls
    const canUseVideoUrls = !useImageWithRoles && videoUrls.length > 0;
    const canUseAudioUrls = !useImageWithRoles && audioUrls.length > 0;

    return compactObject({
      model,
      prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      duration,
      resolution,
      size: aspectRatio,
      seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
      // 注意：seedance-v2 不支持 negative_prompt
      generate_audio: generateAudio || undefined,
      // 互斥：image_urls 与 image_with_roles 二选一
      image_urls: useImageWithRoles ? undefined : (imageUrls.length ? imageUrls : undefined),
      image_with_roles: useImageWithRoles && imageWithRoles.length ? imageWithRoles : undefined,
      video_urls: canUseVideoUrls ? videoUrls : undefined,
      audio_urls: canUseAudioUrls ? audioUrls : undefined,
    });
  }

  if (isApimartKlingVideoModelKind(modelKind)) {
    const klingImageWithRoles = [];
    if (sourceMediaType !== 'video' && firstFrameImage) {
      klingImageWithRoles.push({ image_url: firstFrameImage, role: 'first_frame' });
    }
    if (lastFrameImage) {
      klingImageWithRoles.push({ image_url: lastFrameImage, role: 'last_frame' });
    }
    const klingReferenceImages = uniqueStrings(
      imageRoleEntries
        .filter((item) => item.role !== 'first_frame' && item.role !== 'last_frame' && item.role !== 'composition')
        .map((item) => item.url)
        .filter(Boolean),
    );
    klingReferenceImages.forEach((url) => {
      klingImageWithRoles.push({ image_url: url, role: 'reference' });
    });
    const klingVideoList = [];
    const primaryVideoUrl = sourceMediaType === 'video'
      ? extractFirstString(payload.source_url) || videoUrls[0] || referenceVideo
      : '';
    if (primaryVideoUrl) {
      klingVideoList.push({
        video_url: primaryVideoUrl,
        refer_type: 'base',
        keep_original_sound: generateAudio ? 'yes' : 'no',
      });
    }
    if (modelKind === 'kling-v3-omni' || normalizedModel.includes('kling-v3-omni')) {
      return compactObject({
        model,
        prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
        duration,
        mode: apimartKlingMode({ ...rawPayload, ...payload }),
        aspect_ratio: aspectRatio,
        negative_prompt: extractFirstString(payload.negative_prompt),
        audio: generateAudio || undefined,
        image_with_roles: klingImageWithRoles.length ? klingImageWithRoles : undefined,
        video_list: klingVideoList.length ? klingVideoList : undefined,
      });
    }
    return compactObject({
      model,
      prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      duration,
      mode: apimartKlingMode({ ...rawPayload, ...payload }),
      aspect_ratio: aspectRatio,
      negative_prompt: extractFirstString(payload.negative_prompt),
      audio: generateAudio || undefined,
      image_urls: imageUrls.length ? imageUrls.slice(0, 2) : undefined,
      image_url: sourceMediaType === 'video' ? undefined : firstFrameImage || undefined,
      video_url: referenceVideo || undefined,
    });
  }

  return compactObject({
    ...common,
    first_frame_image: firstFrameImage || undefined,
    last_frame_image: lastFrameImage || undefined,
    reference_image: subjectReferenceImage || undefined,
    reference_video: referenceVideo || undefined,
  });
}

async function executeApimartAsyncGenerationRequest({
  provider,
  mode,
  baseUrl,
  endpoint,
  apiKey,
  payload,
  rawPayload = null,
  timeoutMs = 180000,
  signal,
  userId,
}) {
  // 标准化不同 relay 平台的端点路径
  // suanliai.top / comfly.org 使用 /video/generations（单数），非 /videos/generations（复数）
  let normalizedEndpoint = String(endpoint || '/videos/generations');
  if (/(suanliai\.top|comfly\.org)/i.test(baseUrl || '')) {
    normalizedEndpoint = normalizedEndpoint.replace('/videos/generations', '/video/generations');
  }
  endpoint = normalizedEndpoint;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-hmdao-provider': provider,
    'x-hmdao-mode': mode,
  };
  const normalizedPayload = normalizeApimartAsyncGenerationPayload({
    provider,
    mode,
    endpoint,
    rawPayload: rawPayload && typeof rawPayload === 'object' ? rawPayload : payload,
    payload: payload || {},
  });
  const imageMaterializedPayload = await materializeApimartImageConditioningPayload(
    normalizedPayload || {},
    baseUrl,
    apiKey,
    timeoutMs,
    signal,
  );
  const submitPayload = await materializeApimartVideoConditioningPayload(
    imageMaterializedPayload || {},
    timeoutMs,
    userId,
  );
  const submit = await requestJsonWithOptionalPowerShellRelay({
    baseUrl,
    url: `${baseUrl}${endpoint}`,
    method: 'POST',
    headers,
    body: submitPayload,
    signal,
    timeoutMs,
  });
  const submitData = submit.data || {};
  if (!submit.ok) {
    const message = extractFirstString(submitData?.error?.message) || extractFirstString(submitData?.message) || `Upstream request failed with HTTP ${submit.status}.`;
    return {
      success: false,
      provider,
      mode,
      error: {
        message,
        status: submit.status,
        provider,
        category: classifyProxyError({ status: submit.status, message }),
        code: extractFirstString(submitData?.error?.code) || '',
      },
      raw: {
        submitData,
        submitPayload,
      },
    };
  }

  const taskId = extractApimartTaskId(submitData);
  if (!taskId) {
    return normalizeUpstreamPayload({
      provider,
      mode,
      data: submitData,
      contentType: submit.contentType,
      status: submit.status || 200,
    });
  }

  const startedAt = Date.now();
  let lastTaskData = submitData;
  const statusCandidates = apimartTaskStatusCandidates(baseUrl, endpoint, taskId);
  while (Date.now() - startedAt < timeoutMs) {
    let pollingFailure = null;
    let sawPendingResponse = false;
    for (const statusUrl of statusCandidates) {
      const statusResponse = await requestJsonWithOptionalPowerShellRelay({
        baseUrl,
        url: statusUrl,
        method: 'GET',
        headers,
        signal,
        timeoutMs,
      });
      const statusData = statusResponse.data || {};
      lastTaskData = statusData;

      if (!statusResponse.ok) {
        const message = extractFirstString(statusData?.error?.message) || extractFirstString(statusData?.message) || `Task polling failed with HTTP ${statusResponse.status}.`;
        pollingFailure = {
          success: false,
          provider,
          mode,
          error: {
            message,
            status: statusResponse.status,
            provider,
            category: classifyProxyError({ status: statusResponse.status, message }),
            code: extractFirstString(statusData?.error?.code) || '',
          },
          raw: {
            ...statusData,
            taskId,
            statusUrl,
            statusCandidates,
            submitData,
          },
        };
        continue;
      }

      const phase = normalizeApimartTaskPhase(apimartTaskStatusValue(statusData));
      if (phase === 'success') {
        return normalizeUpstreamPayload({
          provider,
          mode,
          data: buildApimartTaskResultPayload(statusData, submitData),
          contentType: statusResponse.contentType || 'application/json',
          status: statusResponse.status || 200,
        });
      }
      if (phase === 'failed') {
        const message = extractApimartAsyncFailureMessage(statusData);
        return {
          success: false,
          provider,
          mode,
          error: {
            message,
            status: statusResponse.status || 502,
            provider,
            category: classifyProxyError({ status: statusResponse.status || 502, message }),
            code: extractFirstString(statusData?.task?.error?.code) || '',
          },
          raw: {
            ...statusData,
            taskId,
            statusUrl,
            statusCandidates,
            submitData,
          },
        };
      }
      sawPendingResponse = true;
    }

    if (pollingFailure && !sawPendingResponse) {
      return pollingFailure;
    }

    await sleepWithSignal(4000, signal);
  }

  return {
    success: false,
    provider,
    mode,
    error: {
      message: `Upstream request timed out after ${timeoutMs}ms.`,
      status: 0,
      provider,
      code: 'timeout',
      category: 'timeout',
    },
    raw: {
      ...(lastTaskData && typeof lastTaskData === 'object' ? lastTaskData : {}),
      taskId,
      statusCandidates,
      submitData,
    },
  };
}

async function runShellCommandWithInput(commandLine, inputText, cwd = APP_DIR, extraEnv = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-8).join(' | ');
      reject(new Error(`wrapper command exited ${code}: ${detail || 'unknown-error'}`));
    });
    child.stdin.write(String(inputText || ''));
    child.stdin.end();
  });
}

function shellQuotePath(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function interpolateWrapperCommand(commandLine, context = {}) {
  const replacements = {
    payloadPath: shellQuotePath(context.payloadPath || ''),
    inputPath: shellQuotePath(context.inputPath || ''),
    outputPath: shellQuotePath(context.outputPath || ''),
    requestId: String(context.requestId || ''),
    mediaKind: String(context.mediaKind || ''),
    route: String(context.route || ''),
  };
  return String(commandLine || '').replace(/\{\{\s*(payloadPath|inputPath|outputPath|requestId|mediaKind|route)\s*\}\}/g, (_, key) => replacements[key] ?? '');
}

function parseWrapperStdout(stdout, fallbackOutputPath = '') {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return {};
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      if (candidate && (candidate.includes(path.sep) || candidate.startsWith('./') || candidate.startsWith('../')) && !candidate.startsWith('{')) {
        return { outputPath: candidate };
      }
    }
  }
  return fallbackOutputPath ? { outputPath: fallbackOutputPath } : {};
}

async function runJsonWrapperCommand(commandLine, payload, {
  cwd = APP_DIR,
  payloadPath = '',
  fallbackOutputPath = '',
  env = {},
} = {}) {
  const serialized = JSON.stringify(payload);
  let wrapperPayloadPath = payloadPath;
  if (!wrapperPayloadPath) {
    wrapperPayloadPath = path.join(LOCAL_POST_EDIT_DIR, `${String(payload?.requestId || crypto.randomUUID())}-wrapper-payload.json`);
  }
  await fs.writeFile(wrapperPayloadPath, serialized, 'utf8');
  const resolvedCommand = interpolateWrapperCommand(commandLine, {
    payloadPath: wrapperPayloadPath,
    inputPath: payload?.inputPath,
    outputPath: payload?.outputPath,
    requestId: payload?.requestId,
    mediaKind: payload?.mediaKind,
    route: payload?.route,
  });
  const wrapperEnv = {
    HMDAO_WRAPPER_PAYLOAD: wrapperPayloadPath,
    HMDAO_WRAPPER_INPUT: String(payload?.inputPath || ''),
    HMDAO_WRAPPER_OUTPUT: String(payload?.outputPath || ''),
    HMDAO_WRAPPER_REQUEST_ID: String(payload?.requestId || ''),
    HMDAO_WRAPPER_MEDIA_KIND: String(payload?.mediaKind || ''),
    HMDAO_WRAPPER_ROUTE: String(payload?.route || ''),
    ...env,
  };
  const { stdout, stderr } = await runShellCommandWithInput(resolvedCommand, serialized, cwd, wrapperEnv);
  return {
    parsed: parseWrapperStdout(stdout, fallbackOutputPath),
    stdout,
    stderr,
    payloadPath: wrapperPayloadPath,
  };
}

// P1-11：以下 19 个函数已抽取至 lib/media-pipeline-utils.mjs。
import {
  audioExtensionFromMimeType,
  buildHighQualityMp4Args,
  buildWebmEncodeArgs,
  evenSize,
  fileExists,
  floatSamplesToWavBuffer,
  hashString,
  normalizeClipSegments,
  probeImageFile,
  probeMediaStreams,
  probeVideoFile,
  runJsonPythonScript,
  runPreferredLocalPython,
} from './lib/media-pipeline-utils.mjs';

let preferredMp4VideoEncoderPromise = null;

async function resolvePreferredMp4VideoEncoder() {
  if (!preferredMp4VideoEncoderPromise) {
    preferredMp4VideoEncoderPromise = runCommand('ffmpeg', ['-hide_banner', '-encoders'])
      .then(({ stdout }) => {
        const text = String(stdout || '').toLowerCase();
        const candidates = ['libopenh264', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'mpeg4'];
        return candidates.find((item) => text.includes(item.toLowerCase())) || 'mpeg4';
      })
      .catch(() => 'mpeg4');
  }
  return preferredMp4VideoEncoderPromise;
}

const LOCAL_AUDIO_BACKEND_META = {
  'fallback-local': {
    label: '本地预览',
    envCommand: '',
    supportedModes: ['bgm', 'sfx', 'voiceover'],
  },
  audioldm2: {
    label: 'AudioLDM 2',
    envCommand: 'HMDAO_AUDIOLDM2_COMMAND',
    envPath: 'HMDAO_AUDIOLDM2_PATH',
    supportedModes: ['bgm', 'sfx'],
  },
  voxcpm: {
    label: 'VoxCPM',
    envCommand: 'HMDAO_VOXCPM_COMMAND',
    envPath: 'HMDAO_VOXCPM_PATH',
    supportedModes: ['voiceover'],
  },
};

const LOCAL_AUDIO_BACKEND_WRAPPERS = {
  audioldm2: path.resolve(APP_DIR, 'server', 'local_audioldm2_wrapper.mjs'),
  voxcpm: path.resolve(APP_DIR, 'server', 'local_voxcpm_wrapper.mjs'),
};

// P1-10：local-post 运行时常量已收敛至 lib/local-post-constants.mjs（单点导出，ESM 单例共享 Map 实例）。
import {
  LOCAL_POST_BACKEND_WRAPPERS,
  LOCAL_POST_RUNTIME_GUIDES,
  LOCAL_POST_RELEASE_CACHE,
  LOCAL_POST_RELEASE_TTL_MS,
  LOCAL_POST_MANAGED_RUNTIME_DIR,
  LOCAL_POST_RUNTIME_INSTALL_JOBS,
} from './lib/local-post-constants.mjs';

const LOCAL_POST_INSTALLABLE_RUNTIMES = {
  gmic: {
    runtimeKey: 'gmic',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.gmic.runtimeName,
    sourceLabel: 'gmic.eu',
  },
  oiio: {
    runtimeKey: 'oiio',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.oiio.runtimeName,
    sourceLabel: 'PyPI / OpenImageIO',
  },
  ocio: {
    runtimeKey: 'ocio',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.ocio.runtimeName,
    sourceLabel: 'PyPI / OpenColorIO',
  },
  ytdlp: {
    runtimeKey: 'ytdlp',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.ytdlp.runtimeName,
    sourceLabel: 'GitHub / yt-dlp',
  },
  florence2: {
    runtimeKey: 'florence2',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.florence2.runtimeName,
    sourceLabel: 'Hugging Face / PyPI',
  },
  aria2: {
    runtimeKey: 'aria2',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.aria2.runtimeName,
    sourceLabel: 'GitHub Releases',
  },
  ffmpeg: {
    runtimeKey: 'ffmpeg',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.ffmpeg.runtimeName,
    sourceLabel: 'BtbN FFmpeg-Builds',
  },
};
const LOCAL_POST_INSTALL_STEP_TIMEOUT_MS = 45 * 60 * 1000; // 安装步骤（建 venv / 装 torch / 下 2.3GB 权重）必须长超时，否则会被 12s 自检超时杀掉

function normalizeLocalAudioBackend(value) {
  const requested = String(value || 'fallback-local').trim().toLowerCase();
  return requested in LOCAL_AUDIO_BACKEND_META ? requested : 'fallback-local';
}

function resolveLocalAudioBackend(requestedBackend, mode) {
  const requested = normalizeLocalAudioBackend(requestedBackend);
  const requestedMeta = LOCAL_AUDIO_BACKEND_META[requested];
  if (!requestedMeta.supportedModes.includes(mode)) {
    return {
      requestedBackend: requested,
      backend: 'fallback-local',
      backendLabel: LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
      backendAvailable: false,
      fallbackUsed: requested !== 'fallback-local',
      fallbackReason: 'mode-not-supported',
      commandLine: '',
      detectedPath: '',
    };
  }
  if (requested === 'fallback-local') {
    return {
      requestedBackend: requested,
      backend: requested,
      backendLabel: requestedMeta.label,
      backendAvailable: true,
      fallbackUsed: false,
      fallbackReason: '',
      commandLine: '',
      detectedPath: '',
    };
  }

  let commandLine = String(process.env[requestedMeta.envCommand] || '').trim();
  const detectedPath = String(process.env[requestedMeta.envPath] || '').trim();
  if (!commandLine && detectedPath && LOCAL_AUDIO_BACKEND_WRAPPERS[requested]) {
    commandLine = `node "${LOCAL_AUDIO_BACKEND_WRAPPERS[requested]}"`;
  }
  const backendAvailable = Boolean(commandLine);
  return {
    requestedBackend: requested,
    backend: backendAvailable ? requested : 'fallback-local',
    backendLabel: requestedMeta.label,
    backendAvailable,
    fallbackUsed: !backendAvailable,
    fallbackReason: backendAvailable ? '' : 'backend-not-configured',
    commandLine,
    detectedPath,
  };
}

async function runConfiguredLocalAudioBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestId = crypto.randomUUID();
  const requestPayload = {
    requestId,
    mode: payload.mode,
    prompt: payload.prompt,
    duration: payload.duration,
    intensity: payload.intensity,
    voicePreset: payload.voicePreset,
    speechRate: payload.speechRate,
    language: payload.language,
    outputDir: LOCAL_AUDIO_EDIT_DIR,
  };
  const { stdout } = await runShellCommandWithInput(
    resolvedBackend.commandLine,
    JSON.stringify(requestPayload),
    APP_DIR,
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  const outputPath = String(parsed.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  const mimeType = String(parsed.mimeType || 'audio/wav');
  const format = String(parsed.format || audioExtensionFromMimeType(mimeType));
  let persisted = null;
  let meta = {
    duration: Math.max(0, Number(parsed.duration || 0)),
    sampleRate: Math.max(0, Number(parsed.sampleRate || 0)),
    channels: Math.max(0, Number(parsed.channels || 0)),
  };

  if (outputPath) {
    meta = await probeAudioFile(outputPath);
    persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, outputPath, requestId, format);
  } else if (outputBase64) {
    persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, Buffer.from(outputBase64, 'base64'), requestId, format);
  }

  if (!persisted?.persistedPath) {
    throw new Error(`local-audio-backend-empty:${resolvedBackend.requestedBackend}`);
  }
  const stat = await fs.stat(persisted.persistedPath);

  return {
    mode: payload.mode,
    engine: String(parsed.engine || resolvedBackend.requestedBackend),
    voiceName: String(parsed.voiceName || ''),
    format,
    mimeType,
    outputAssetId: persisted.assetId,
    outputUrl: `/api/local-audio/result/${encodeURIComponent(persisted.assetId)}`,
    size: Number(stat.size || 0),
    duration: meta.duration,
    sampleRate: meta.sampleRate || 44100,
    channels: meta.channels || 2,
    requestedBackend: resolvedBackend.requestedBackend,
    backend: resolvedBackend.requestedBackend,
    backendLabel: resolvedBackend.backendLabel,
    backendAvailable: true,
    fallbackUsed: false,
    fallbackReason: '',
  };
}

function generateProceduralBgmBuffer(prompt, duration, intensity = 0.6) {
  const sampleRate = 44100;
  const seconds = clampNumber(duration, 2, 30, 8);
  const totalFrames = Math.max(1, Math.round(seconds * sampleRate));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const hash = hashString(prompt);
  const rootPool = [110, 123.47, 130.81, 146.83, 164.81, 174.61, 196, 220];
  const root = rootPool[hash % rootPool.length];
  const moodMinor = /夜|暗|悬|雨|压迫|myst|dark|suspense|noir/i.test(prompt);
  const intervals = moodMinor ? [1, 1.2, 1.5, 1.8] : [1, 1.25, 1.5, 2];
  const barDuration = 1.6;
  const padGain = 0.08 + intensity * 0.06;
  const pulseGain = 0.035 + intensity * 0.05;
  const noiseGain = 0.004 + intensity * 0.01;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const time = frame / sampleRate;
    const barIndex = Math.floor(time / barDuration);
    const chordIndex = barIndex % intervals.length;
    const base = root * intervals[chordIndex];
    const swell = 0.58 + 0.42 * Math.sin((Math.PI * 2 * time) / barDuration - Math.PI / 2);
    const pulse = Math.max(0, Math.sin((Math.PI * 2 * time) / (barDuration / 2)));
    const detune = 1 + (((hash >> (barIndex % 8)) & 3) - 1.5) * 0.0025;
    const pad =
      Math.sin(Math.PI * 2 * base * detune * time) * 0.55 +
      Math.sin(Math.PI * 2 * base * 0.5 * time + 0.6) * 0.3 +
      Math.sin(Math.PI * 2 * base * 1.5 * time + 1.2) * 0.15;
    const sparkle = Math.sin(Math.PI * 2 * (base * 2.01) * time + 0.5) * pulse;
    const noise = (Math.sin(Math.PI * 2 * 53 * time + hash * 0.0001) + Math.sin(Math.PI * 2 * 97 * time)) * 0.5;
    const mono = pad * swell * padGain + sparkle * pulseGain + noise * noiseGain;
    left[frame] = mono * 0.96;
    right[frame] = mono * 0.9 + Math.sin(Math.PI * 2 * (base * 0.25) * time) * 0.01;
  }

  return {
    buffer: floatSamplesToWavBuffer([left, right], sampleRate),
    sampleRate,
    channels: 2,
    duration: seconds,
    engine: 'procedural-bgm-synth',
  };
}

function generateProceduralSfxBuffer(prompt, duration, intensity = 0.65) {
  const sampleRate = 44100;
  const seconds = clampNumber(duration, 0.4, 8, 2.4);
  const totalFrames = Math.max(1, Math.round(seconds * sampleRate));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const normalized = String(prompt || '').toLowerCase();
  const hash = hashString(prompt);
  const kind = /爆|炸|impact|hit|boom|thump/i.test(normalized)
    ? 'impact'
    : /呼|风|whoosh|sweep|swish/i.test(normalized)
      ? 'whoosh'
      : /激光|电|laser|zap|sci/i.test(normalized)
        ? 'laser'
        : /滴|点|click|ui|通知|beep/i.test(normalized)
          ? 'ui'
          : 'rise';

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const time = frame / sampleRate;
    const progress = time / seconds;
    const seedNoise = Math.sin(Math.PI * 2 * (37 + (hash % 19)) * time) + Math.sin(Math.PI * 2 * (81 + (hash % 13)) * time);
    let mono = 0;

    if (kind === 'impact') {
      const envelope = Math.exp(-6.5 * progress);
      const body = Math.sin(Math.PI * 2 * 68 * time) * envelope;
      const crunch = seedNoise * 0.08 * envelope;
      mono = body * 0.7 + crunch;
    } else if (kind === 'whoosh') {
      const sweep = 280 + progress * 1600;
      const envelope = Math.sin(Math.PI * progress);
      mono = Math.sin(Math.PI * 2 * sweep * time) * 0.12 * envelope + seedNoise * 0.03 * envelope;
    } else if (kind === 'laser') {
      const sweep = 980 - progress * 720;
      const envelope = Math.exp(-3.8 * progress);
      mono = Math.sin(Math.PI * 2 * sweep * time) * 0.16 * envelope + Math.sin(Math.PI * 2 * sweep * 0.5 * time) * 0.06 * envelope;
    } else if (kind === 'ui') {
      const envelope = Math.exp(-10 * progress);
      mono = Math.sin(Math.PI * 2 * 880 * time) * 0.16 * envelope + Math.sin(Math.PI * 2 * 1320 * time) * 0.08 * envelope;
    } else {
      const envelope = Math.sin(Math.PI * progress) ** 1.5;
      const sweep = 220 + progress * 540;
      mono = Math.sin(Math.PI * 2 * sweep * time) * 0.15 * envelope + seedNoise * 0.02 * envelope;
    }

    const stereoDrift = Math.sin(Math.PI * 2 * 0.4 * time) * 0.08;
    left[frame] = mono * (0.82 + stereoDrift) * (0.7 + intensity * 0.5);
    right[frame] = mono * (0.82 - stereoDrift) * (0.7 + intensity * 0.5);
  }

  return {
    buffer: floatSamplesToWavBuffer([left, right], sampleRate),
    sampleRate,
    channels: 2,
    duration: seconds,
    engine: `procedural-sfx-${kind}`,
  };
}

function generateProceduralVoiceoverBuffer(prompt, duration, speechRate = 0) {
  const sampleRate = 22050;
  const normalized = String(prompt || '').trim();
  const glyphs = Array.from(normalized.replace(/\s+/g, '')).slice(0, 160);
  const tokenCount = Math.max(glyphs.length, 1);
  const speakingRate = Math.max(0.7, Math.min(1.5, 1 + (clampNumber(speechRate, -6, 6, 0) * 0.08)));
  const seconds = Math.max(1, Math.min(20, Number(duration || 0) || Math.max(3, tokenCount / 3.2 / speakingRate)));
  const totalFrames = Math.max(1, Math.floor(sampleRate * seconds));
  const mono = new Float32Array(totalFrames);
  const segmentDuration = seconds / tokenCount;

  for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex += 1) {
    const glyph = glyphs[tokenIndex] || normalized[tokenIndex] || 'A';
    const code = glyph.codePointAt(0) || 65;
    const startTime = tokenIndex * segmentDuration;
    const voicedDuration = Math.max(0.06, segmentDuration * 0.82);
    const endTime = Math.min(seconds, startTime + voicedDuration);
    const startFrame = Math.max(0, Math.floor(startTime * sampleRate));
    const endFrame = Math.min(totalFrames, Math.ceil(endTime * sampleRate));
    const contour = Math.sin((tokenIndex / Math.max(tokenCount - 1, 1)) * Math.PI);
    const baseFreq = 155 + (code % 9) * 12 + contour * 28;

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const time = frame / sampleRate;
      const local = time - startTime;
      const voicedProgress = local / Math.max(voicedDuration, 1e-3);
      const attack = Math.min(1, voicedProgress / 0.12);
      const release = Math.min(1, (1 - voicedProgress) / 0.18);
      const envelope = Math.max(0, Math.min(attack, release)) ** 0.72;
      const vibrato = 1 + Math.sin(Math.PI * 2 * (4.2 + (code % 3) * 0.6) * local) * 0.014;
      const freq = baseFreq * vibrato;
      const harmonicA = Math.sin(Math.PI * 2 * freq * local);
      const harmonicB = Math.sin(Math.PI * 2 * freq * 2.08 * local) * 0.42;
      const harmonicC = Math.sin(Math.PI * 2 * freq * 3.14 * local) * 0.18;
      const aspiration = (Math.sin(Math.PI * 2 * (800 + (code % 11) * 55) * local) * 0.015) + (Math.sin(Math.PI * 2 * 1200 * local) * 0.008);
      mono[frame] += (harmonicA * 0.78 + harmonicB + harmonicC + aspiration) * envelope * 0.22;
    }
  }

  return {
    buffer: floatSamplesToWavBuffer([mono], sampleRate),
    sampleRate,
    channels: 1,
    duration: seconds,
    engine: 'procedural-voiceover-fallback',
  };
}

async function synthesizeNarrationToFile({ outputPath, text, voicePreset = 'narrator', speechRate = 0 }) {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$voicePreset = '${escapePowerShellSingleQuoted(voicePreset)}'`,
    '$voices = $speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }',
    '$selected = $null',
    'if ($voicePreset -eq "female" -or $voicePreset -eq "gentle" -or $voicePreset -eq "calm") { $selected = $voices | Where-Object { $_ -match "Female|女|Xiaoxiao|Huihui|Zira|Jenny" } | Select-Object -First 1 }',
    'elseif ($voicePreset -eq "male" -or $voicePreset -eq "documentary") { $selected = $voices | Where-Object { $_ -match "Male|男|Yunxi|David|Mark|Haohao" } | Select-Object -First 1 }',
    'elseif ($voicePreset -eq "warm" -or $voicePreset -eq "friendly") { $selected = $voices | Where-Object { $_ -match "Huihui|Zira|Hazel|Jenny|Xiaoyi" } | Select-Object -First 1 }',
    'elseif ($voicePreset -eq "energetic" -or $voicePreset -eq "commercial") { $selected = $voices | Where-Object { $_ -match "David|Mark|Yunxi|Xiaoxiao|Zira" } | Select-Object -First 1 }',
    'else { $selected = $voices | Select-Object -First 1 }',
    'if ($selected) { $speaker.SelectVoice($selected) }',
    `$speaker.Rate = ${Math.round(clampNumber(speechRate, -6, 6, 0))}`,
    '$speaker.Volume = 100',
    `$speaker.SetOutputToWaveFile('${escapePowerShellSingleQuoted(outputPath)}')`,
    `$speaker.Speak('${escapePowerShellSingleQuoted(text)}')`,
    '$voiceName = if ($selected) { $selected } else { "" }',
    '$speaker.Dispose()',
    'Write-Output $voiceName',
  ].join('; ');

  const { stdout } = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  return String(stdout || '').trim();
}

async function processLocalAudioGenerateRequest(payload) {
  const mode = String(payload?.mode || '').trim().toLowerCase();
  if (!['bgm', 'sfx', 'voiceover'].includes(mode)) {
    throw new Error(`unsupported-local-audio-mode:${mode || 'unknown'}`);
  }

  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) {
    throw new Error('local-audio-prompt-missing');
  }

  const duration = clampNumber(payload?.duration, mode === 'voiceover' ? 1 : 0.4, 30, mode === 'voiceover' ? 8 : 6);
  const intensity = clampNumber(payload?.intensity, 0, 1, 0.6);
  const speechRate = clampNumber(payload?.speechRate, -6, 6, 0);
  const resolvedBackend = resolveLocalAudioBackend(payload?.backend, mode);

  if (resolvedBackend.backend !== 'fallback-local' && resolvedBackend.commandLine) {
    try {
      await fs.mkdir(LOCAL_AUDIO_EDIT_DIR, { recursive: true });
      return await runConfiguredLocalAudioBackend(resolvedBackend, {
        mode,
        prompt,
        duration,
        intensity,
        voicePreset: String(payload?.voicePreset || 'narrator'),
        speechRate,
        language: String(payload?.language || ''),
      });
    } catch (error) {
      resolvedBackend.backend = 'fallback-local';
      resolvedBackend.fallbackUsed = true;
      resolvedBackend.fallbackReason = error instanceof Error ? error.message : 'backend-exec-failed';
      resolvedBackend.backendAvailable = false;
    }
  }

  if (mode === 'voiceover') {
    await fs.mkdir(LOCAL_AUDIO_EDIT_DIR, { recursive: true });
    const requestId = crypto.randomUUID();
    const outputPath = path.join(LOCAL_AUDIO_EDIT_DIR, `${requestId}-voice.wav`);
    try {
      const voiceName = await synthesizeNarrationToFile({
        outputPath,
        text: prompt,
        voicePreset: String(payload?.voicePreset || 'narrator'),
        speechRate,
      });
      const meta = await probeAudioFile(outputPath);
      const persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, outputPath, requestId, 'wav');
      const stat = await fs.stat(persisted.persistedPath);
      const hasUsableNarration = Number(stat.size || 0) > 1024 && Number(meta.duration || 0) > 0.2;
      if (!hasUsableNarration) {
        const generated = generateProceduralVoiceoverBuffer(prompt, duration, speechRate);
        const fallbackPersisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, generated.buffer, requestId, 'wav');
        const fallbackStat = await fs.stat(fallbackPersisted.persistedPath);
        return {
          mode,
          engine: generated.engine,
          voiceName,
          format: 'wav',
          mimeType: 'audio/wav',
          outputAssetId: fallbackPersisted.assetId,
          outputUrl: `/api/local-audio/result/${encodeURIComponent(fallbackPersisted.assetId)}`,
          size: Number(fallbackStat.size || 0),
          duration: generated.duration,
          sampleRate: generated.sampleRate,
          channels: generated.channels,
          requestedBackend: resolvedBackend.requestedBackend,
          backend: 'fallback-local',
          backendLabel: LOCAL_AUDIO_BACKEND_META[resolvedBackend.requestedBackend]?.label || LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
          backendAvailable: resolvedBackend.requestedBackend === 'fallback-local',
          fallbackUsed: true,
          fallbackReason: 'voice-sapi-empty-output',
        };
      }
      return {
        mode,
        engine: 'windows-sapi',
        voiceName,
        format: 'wav',
        mimeType: 'audio/wav',
        outputAssetId: persisted.assetId,
        outputUrl: `/api/local-audio/result/${encodeURIComponent(persisted.assetId)}`,
        size: Number(stat.size || 0),
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        requestedBackend: resolvedBackend.requestedBackend,
        backend: 'fallback-local',
        backendLabel: LOCAL_AUDIO_BACKEND_META[resolvedBackend.requestedBackend]?.label || LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
        backendAvailable: resolvedBackend.requestedBackend === 'fallback-local',
        fallbackUsed: resolvedBackend.requestedBackend !== 'fallback-local',
        fallbackReason: resolvedBackend.fallbackReason || (resolvedBackend.requestedBackend === 'fallback-local' ? '' : 'backend-not-configured'),
      };
    } finally {
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  }

  const generated = mode === 'sfx'
    ? generateProceduralSfxBuffer(prompt, duration, intensity)
    : generateProceduralBgmBuffer(prompt, duration, intensity);
  const requestId = crypto.randomUUID();
  const persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, generated.buffer, requestId, 'wav');
  const stat = await fs.stat(persisted.persistedPath);

  return {
    mode,
    engine: generated.engine,
    format: 'wav',
    mimeType: 'audio/wav',
    outputAssetId: persisted.assetId,
    outputUrl: `/api/local-audio/result/${encodeURIComponent(persisted.assetId)}`,
    size: Number(stat.size || 0),
    duration: generated.duration,
    sampleRate: generated.sampleRate,
    channels: generated.channels,
    requestedBackend: resolvedBackend.requestedBackend,
    backend: 'fallback-local',
    backendLabel: LOCAL_AUDIO_BACKEND_META[resolvedBackend.requestedBackend]?.label || LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
    backendAvailable: resolvedBackend.requestedBackend === 'fallback-local',
    fallbackUsed: resolvedBackend.requestedBackend !== 'fallback-local',
    fallbackReason: resolvedBackend.fallbackReason || (resolvedBackend.requestedBackend === 'fallback-local' ? '' : 'backend-not-configured'),
  };
}

async function resolveAudioProviderApiKey(providerId) {
  const records = listActivatedProviderRecords().filter((r) => String(r?.provider || '').trim() === String(providerId).trim());
  const exactAudio = records.find((r) => String(r?.mode || '').trim() === 'audio');
  if (exactAudio) return String(exactAudio.apiKey || '').trim();
  // 优先使用原生密钥（无自定义 endpoint），避免中继 key 无法代理该服务（如百炼 TTS）
  const native = records.find((r) => !r?.endpoint);
  if (native) return String(native.apiKey || '').trim();
  const any = records[0];
  return any ? String(any.apiKey || '').trim() : '';
}

function catalogAudioModelById(modelId) {
  return MODEL_CATALOG.find((m) => m.id === modelId) || null;
}

function mapVoicePresetToMinimax(voicePreset) {
  const v = String(voicePreset || '').toLowerCase();
  if (v.includes('female')) return 'female-yujie';
  if (v.includes('male')) return 'male-qn-qingse';
  return 'male-qn-qingse';
}

function buildMinimaxMusicPrompt(prompt, mode) {
  const base = String(prompt || '').trim();
  if (mode === 'sfx') return `纯音效：${base}。无人声、无歌词，仅环境音/拟音/音效铺底。`;
  return base || '生成一段氛围舒缓、适合短视频使用的背景音乐。';
}

async function generateAudioViaMinimax({ mode, prompt, voicePreset, speechRate, apiKey, upstreamModel }) {
  const base = 'https://api.minimaxi.com/v1';
  const isMusic = mode === 'bgm' || mode === 'sfx';
  if (isMusic) {
    const model = upstreamModel && upstreamModel !== 'minimax-music-01' ? upstreamModel : 'music-01';
    const submit = await fetch(`${base}/music_generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt: buildMinimaxMusicPrompt(prompt, mode) }),
    });
    const sj = await submit.json().catch(() => ({}));
    const taskId = sj?.data?.task_id || sj?.task_id;
    if (!taskId) throw new Error(`minimax-music-submit-failed:${submit.status} ${JSON.stringify(sj).slice(0, 300)}`);
    let audioUrl = null;
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await fetch(`${base}/get_music?task_id=${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      const pj = await poll.json().catch(() => ({}));
      const status = pj?.data?.status || pj?.status;
      if (status === 'SUCCESS' || status === 'success' || pj?.data?.audio || pj?.audio) {
        audioUrl = pj?.data?.audio || pj?.audio || pj?.data?.stream_audio || pj?.data?.audio_file;
        if (audioUrl) break;
      }
      if (status === 'FAILED' || status === 'failed') throw new Error(`minimax-music-failed:${JSON.stringify(pj).slice(0, 300)}`);
    }
    if (!audioUrl) throw new Error('minimax-music-timeout');
    const bytes = await downloadRemoteMediaBuffer(audioUrl);
    return { buffer: bytes.bytes, mimeType: bytes.mimeType || 'audio/mp3', ext: audioExtensionFromMimeType(bytes.mimeType) || 'mp3' };
  }
  const model = upstreamModel && upstreamModel !== 'minimax-speech-28' ? upstreamModel : 'speech-2.8-hd';
  const tts = await fetch(`${base}/t2a_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      text: prompt,
      voice_setting: { voice_id: mapVoicePresetToMinimax(voicePreset), speed: clampNumber(Number(speechRate || 1), 0.5, 2, 1) },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    }),
  });
  const tj = await tts.json().catch(() => ({}));
  const audioB64 = tj?.data?.audio || tj?.audio;
  if (!audioB64) {
    const audioFile = tj?.data?.audio_file || tj?.audio_file;
    if (audioFile) {
      const bytes = await downloadRemoteMediaBuffer(audioFile);
      return { buffer: bytes.bytes, mimeType: bytes.mimeType || 'audio/mp3', ext: audioExtensionFromMimeType(bytes.mimeType) || 'mp3' };
    }
    throw new Error(`minimax-tts-failed:${tts.status} ${JSON.stringify(tj).slice(0, 300)}`);
  }
  const buffer = Buffer.from(String(audioB64), 'base64');
  return { buffer, mimeType: 'audio/mp3', ext: 'mp3' };
}

async function generateAudioViaVolcengine({ prompt, speechRate, apiKey, upstreamModel }) {
  // 火山方舟生成类模型必须走推理接入点 ep-xxxx（裸模型名返回 InvalidEndpointOrModel.NotFound）。
  // 统一入口为 /api/v3/chat/completions（其余 audio/* 路径探针实测均 404）。
  const base = 'https://ark.cn-beijing.volces.com/api/v3';
  const model = String(upstreamModel || 'doubao-audio-1.0').trim();
  const submit = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: String(prompt || '生成一段背景音乐') }],
    }),
  });
  const sj = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    throw new Error(`volcengine-audio-submit-failed:${submit.status} ${JSON.stringify(sj).slice(0, 400)}`);
  }
  const content = String(sj?.choices?.[0]?.message?.content || '');
  // 情况1：同步返回 data URI base64 音频
  const dataMatch = content.match(/data:audio\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
  if (dataMatch) {
    const buffer = Buffer.from(dataMatch[1], 'base64');
    const mime = (content.match(/data:(audio\/[^;]+)/) || [])[1] || 'audio/wav';
    return { buffer, mimeType: mime, ext: audioExtensionFromMimeType(mime) || 'wav' };
  }
  // 情况2：同步返回音频 URL
  const urlMatch = content.match(/https?:\/\/\S+\.(wav|mp3|ogg|m4a|flac)/i);
  if (urlMatch) {
    const bytes = await downloadRemoteMediaBuffer(urlMatch[0]);
    return { buffer: bytes.bytes, mimeType: bytes.mimeType || 'audio/wav', ext: audioExtensionFromMimeType(bytes.mimeType) || 'wav' };
  }
  // 情况3：异步任务（返回 task_id），轮询结果
  const taskId = sj?.id || sj?.task_id || sj?.data?.task_id;
  if (taskId) {
    let audioUrl = null;
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      const pj = await poll.json().catch(() => ({}));
      const url = pj?.url || pj?.data?.url || pj?.audio_url || pj?.choices?.[0]?.message?.content;
      if (url && /^https?:\/\//.test(String(url))) { audioUrl = String(url); break; }
      if (/failed/i.test(String(pj?.status || ''))) throw new Error(`volcengine-audio-failed:${JSON.stringify(pj).slice(0, 300)}`);
    }
    if (!audioUrl) throw new Error('volcengine-audio-timeout');
    const bytes = await downloadRemoteMediaBuffer(audioUrl);
    return { buffer: bytes.bytes, mimeType: bytes.mimeType || 'audio/wav', ext: audioExtensionFromMimeType(bytes.mimeType) || 'wav' };
  }
  throw new Error(`volcengine-audio-unexpected-response:${JSON.stringify(sj).slice(0, 400)}`);
}

const QWEN3_TTS_VOICE_VALUES = QWEN3_TTS_VOICES.map(v => v.value);

async function generateAudioViaQwen3({ mode, prompt, voicePreset, instructions, speechRate = 1, apiKey, upstreamModel, workspaceId }) {
  const wsId = String(workspaceId || process.env.DASHSCOPE_WORKSPACE_ID || '').trim();
  const base = wsId
    ? `https://${wsId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
    : 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  const model = String(upstreamModel || 'qwen3-tts-instruct-flash').trim();
  const rawVoice = String(voicePreset || '').trim();
  const voice = QWEN3_TTS_VOICE_VALUES.includes(rawVoice) ? rawVoice : 'Cherry';
  const text = String(prompt || '生成一段语音').trim();
  const input = { text, voice };
  const ins = String(instructions || '').trim();
  if (ins) {
    input.instructions = ins;
    input.optimize_instructions = true;
  }
  const submit = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input }),
  });
  const sj = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error(`qwen3-tts-submit-failed:${submit.status} ${JSON.stringify(sj).slice(0, 400)}`);
  const audio = sj?.output?.audio;
  const audioUrl = audio?.url;
  const audioData = audio?.data;
  if (audioData) {
    const match = String(audioData).match(/^data:audio\/([^;]+);base64,(.*)$/);
    if (match) {
      const buffer = Buffer.from(match[2], 'base64');
      return { buffer, mimeType: `audio/${match[1]}`, ext: match[1] };
    }
    const buffer = Buffer.from(String(audioData), 'base64');
    return { buffer, mimeType: 'audio/wav', ext: 'wav' };
  }
  if (audioUrl) {
    const bytes = await downloadRemoteMediaBuffer(String(audioUrl));
    return { buffer: bytes.bytes, mimeType: bytes.mimeType || 'audio/wav', ext: audioExtensionFromMimeType(bytes.mimeType) || 'wav' };
  }
  throw new Error(`qwen3-tts-unexpected-response:${JSON.stringify(sj).slice(0, 400)}`);
}

async function generateAudioViaQwen({ mode, prompt, voicePreset, speechRate, apiKey, upstreamModel, workspaceId }) {
  // 阿里百炼 / DashScope 非实时语音合成（Qwen-Audio-3.0-TTS）
  // TTS 服务需走工作空间主机；未配置 workspaceId 时回退到默认 dashscope 主机
  const wsId = String(workspaceId || process.env.DASHSCOPE_WORKSPACE_ID || '').trim();
  const base = wsId
    ? `https://${wsId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
    : 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
  const model = String(upstreamModel || 'qwen-audio-3.0-tts-flash').trim();
  // 旧版 Qwen-Audio-3.0-TTS：flash 音色 longanhuan_v3.6/longjielidou_v3.6/loongeva_v3.6/loongjohn；plus 音色 longanlingxin/longanlufeng
  // voicePreset 可能是 'female'/'male' 语义标签或真实音色名，做兼容映射
  const rawVoice = String(voicePreset || '').trim();
  const FLASH_VOICES = ['longanhuan_v3.6', 'longjielidou_v3.6', 'loongeva_v3.6', 'loongjohn'];
  const PLUS_VOICES = ['longanlingxin', 'longanlufeng'];
  const FLAME_MAP = { female: 'longanhuan_v3.6', male: 'longjielidou_v3.6', f: 'longanhuan_v3.6', m: 'longjielidou_v3.6' };
  const PLUS_MAP = { female: 'longanlingxin', male: 'longanlufeng', f: 'longanlingxin', m: 'longanlufeng' };
  const map = String(model).includes('plus') ? PLUS_MAP : FLAME_MAP;
  const valid = String(model).includes('plus') ? PLUS_VOICES : FLASH_VOICES;
  let voice;
  if (valid.includes(rawVoice)) voice = rawVoice;
  else if (map[rawVoice.toLowerCase()]) voice = map[rawVoice.toLowerCase()];
  else voice = valid[0];
  const submit = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: {
        text: String(prompt || '生成一段语音').trim(),
        voice,
        format: 'wav',
        sample_rate: 24000,
      },
    }),
  });
  const sj = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error(`qwen-audio-submit-failed:${submit.status} ${JSON.stringify(sj).slice(0, 400)}`);
  const audio = sj?.output?.audio || sj?.audio;
  const audioUrl = audio?.url;
  const audioData = audio?.data;
  if (audioData) {
    const match = String(audioData).match(/^data:audio\/([^;]+);base64,(.*)$/);
    if (match) {
      const buffer = Buffer.from(match[2], 'base64');
      return { buffer, mimeType: `audio/${match[1]}`, ext: match[1] };
    }
    const buffer = Buffer.from(String(audioData), 'base64');
    return { buffer, mimeType: 'audio/wav', ext: 'wav' };
  }
  if (audioUrl) {
    const bytes = await downloadRemoteMediaBuffer(String(audioUrl));
    return { buffer: bytes.bytes, mimeType: bytes.mimeType || 'audio/wav', ext: audioExtensionFromMimeType(bytes.mimeType) || 'wav' };
  }
  throw new Error(`qwen-audio-unexpected-response:${JSON.stringify(sj).slice(0, 400)}`);
}

async function processRemoteAudioGenerateRequest(payload) {
  const modelId = String(payload?.model || '').trim();
  const catalogModel = catalogAudioModelById(modelId);
  const provider = String(payload?.provider || catalogModel?.provider || '').trim();
  const upstreamModel = String(payload?.upstreamModel || catalogModel?.upstreamModel || modelId).trim();
  const mode = String(payload?.mode || catalogModel?.capabilities?.generationModes?.[0] || 'bgm').trim().toLowerCase();
  if (!provider) throw new Error(`audio-model-unknown-provider:${modelId}`);
  const apiKey = await resolveAudioProviderApiKey(provider);
  if (!apiKey) throw new Error(`missing-provider-api-key:${provider}（请在 BYOK 中配置该服务商密钥）`);
  let generated;
  if (provider === 'minimax') {
    generated = await generateAudioViaMinimax({
      mode,
      prompt: String(payload?.prompt || '').trim(),
      duration: Number(payload?.duration || 0),
      intensity: Number(payload?.intensity || 0.62),
      voicePreset: String(payload?.voicePreset || ''),
      speechRate: Number(payload?.speechRate || 1),
      apiKey,
      upstreamModel: resolveArkModel(modelId, upstreamModel),
    });
  } else if (provider === 'volcengine') {
    generated = await generateAudioViaVolcengine({
      mode,
      prompt: String(payload?.prompt || '').trim(),
      duration: Number(payload?.duration || 0),
      intensity: Number(payload?.intensity || 0.62),
      voicePreset: String(payload?.voicePreset || ''),
      speechRate: Number(payload?.speechRate || 1),
      apiKey,
      upstreamModel,
    });
  } else if (provider === 'bailian') {
    const bailianRec = getActivatedProviderRecord('bailian', 'audio') || getActivatedProviderRecord('bailian', '');
    const wsId = bailianRec?.workspaceId || payload?.workspaceId || '';
    if (String(upstreamModel || '').includes('qwen3-tts')) {
      generated = await generateAudioViaQwen3({
        mode,
        prompt: String(payload?.prompt || '').trim(),
        voicePreset: String(payload?.voicePreset || ''),
        instructions: String(payload?.instructions || ''),
        speechRate: Number(payload?.speechRate || 1),
        apiKey,
        upstreamModel,
        workspaceId: wsId,
      });
    } else {
      generated = await generateAudioViaQwen({
        mode,
        prompt: String(payload?.prompt || '').trim(),
        voicePreset: String(payload?.voicePreset || ''),
        speechRate: Number(payload?.speechRate || 1),
        apiKey,
        upstreamModel,
        workspaceId: wsId,
      });
    }
  } else {
    throw new Error(`unsupported-audio-provider:${provider}`);
  }
  const requestId = crypto.randomUUID();
  const persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, generated.buffer, requestId, generated.ext || 'wav');
  const stat = await fs.stat(persisted.persistedPath).catch(() => ({ size: 0 }));
  const probed = await probeAudioFile(persisted.persistedPath).catch(() => ({}));
  return {
    mode,
    engine: modelId,
    format: generated.ext || 'wav',
    mimeType: generated.mimeType || 'audio/wav',
    outputUrl: `/api/local-audio/result/${encodeURIComponent(persisted.assetId)}`,
    outputAssetId: persisted.assetId,
    size: Number(stat?.size || 0),
    duration: Number(probed?.duration || payload?.duration || 0),
    sampleRate: Number(probed?.sampleRate || 0),
    channels: Number(probed?.channels || 0),
    requestedBackend: modelId,
    backend: modelId,
    backendLabel: catalogModel?.name || modelId,
    backendAvailable: true,
    fallbackUsed: false,
    fallbackReason: '',
  };
}

async function probeAudioFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=sample_rate,channels:format=duration',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    duration: Math.max(0, Number(parsed?.format?.duration || 0)),
    sampleRate: Math.max(0, Number(parsed?.streams?.[0]?.sample_rate || 0)),
    channels: Math.max(0, Number(parsed?.streams?.[0]?.channels || 0)),
  };
}

async function createSilentAudioFile(filePath, durationSeconds, {
  sampleRate = 48000,
  channels = 2,
} = {}) {
  const safeDuration = Math.max(0.1, Number.isFinite(durationSeconds) ? Number(durationSeconds) : 0.1);
  const channelLayout = channels === 1 ? 'mono' : 'stereo';
  await runCommand('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=${channelLayout}:sample_rate=${sampleRate}`,
    '-t',
    safeDuration.toFixed(3),
    '-acodec',
    'pcm_s16le',
    filePath,
  ]);
}

async function downloadOrWriteAudioInput(requestId, payload) {
  const inputBase64 = String(payload?.linkedAudioBase64 || '').trim();
  const sourceUrl = String(payload?.linkedAudioSourceUrl || '').trim();
  if (!inputBase64 && !/^https?:\/\//i.test(sourceUrl)) return null;
  const mimeType = String(payload?.linkedAudioMimeType || 'audio/wav').trim() || 'audio/wav';
  const inputExt = audioExtensionFromMimeType(mimeType);
  const inputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-linked-audio.${inputExt}`);
  if (inputBase64) {
    await fs.writeFile(inputPath, Buffer.from(inputBase64, 'base64'));
  } else {
    const remote = await downloadRemoteMediaBuffer(sourceUrl);
    await fs.writeFile(inputPath, remote.bytes);
  }
  return inputPath;
}

async function mixExternalAudioIntoVideo({
  videoPath,
  audioPath,
  outputPath,
  mixMode = 'bgm-under',
  audioGain = 1,
  videoGain = 1,
}) {
  const normalizedMixMode = ['replace', 'bgm-under', 'voiceover-dub'].includes(String(mixMode || ''))
    ? String(mixMode)
    : 'bgm-under';
  const safeAudioGain = clampNumber(audioGain, 0, 2, 1);
  const safeVideoGain = clampNumber(videoGain, 0, 2, normalizedMixMode === 'voiceover-dub' ? 0.3 : 0.74);
  const streams = await probeMediaStreams(videoPath);

  if (!streams.hasAudio || normalizedMixMode === 'replace') {
    await runCommand('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-shortest',
      outputPath,
    ]);
    return `external-audio:${normalizedMixMode}`;
  }

  await runCommand('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-filter_complex',
    `[0:a]volume=${safeVideoGain}[va];[1:a]volume=${safeAudioGain}[ea];[va][ea]amix=inputs=2:duration=first:normalize=0[aout]`,
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-shortest',
    outputPath,
  ]);
  return `external-audio:${normalizedMixMode}`;
}

function localVideoEditStatusCode(message) {
  const normalized = String(message || '').toLowerCase();
  if (
    normalized.includes('unsupported-local-video-operation')
    || normalized.includes('local-video-input-missing')
    || normalized.includes('local-video-source-metadata-missing')
    || normalized.includes('local-video-clip-segments-empty')
    || normalized.includes('local-video-linked-audio-missing')
  ) {
    return 400;
  }
  if (normalized.includes('local-video-audio-track-missing')) {
    return 422;
  }
  return 500;
}

async function runLocalParseAnalysis(inputPath, sampleFps, options = {}) {
  return await runJsonPythonScript(LOCAL_VIDEO_PARSE_SCRIPT, [
    '--input',
    inputPath,
    '--sample-fps',
    String(sampleFps),
    '--scene-threshold',
    '24',
    '--max-scenes',
    '12',
    '--scene-engine',
    String(options.sceneEngine || 'auto'),
    '--semantic-engine',
    String(options.semanticEngine || 'auto'),
  ]);
}

function shouldEnhanceVideoParseWithImageInterrogation(requestedSemanticEngine) {
  const requested = String(requestedSemanticEngine || 'auto').trim().toLowerCase();
  if (['clip-interrogator', 'prompt-fusion', 'qwen25-vl', 'qwen35-vl', 'florence2', 'custom-api'].includes(requested)) return true;
  if (requested === 'auto') {
    return resolveImageAnalysisRuntime('auto').mode !== 'fallback';
  }
  return false;
}

function buildEnhancedVideoParseSummary(summary, rows, engineLabel) {
  const subjects = uniqueStrings(rows.map((row) => String(row?.subjectSummary || row?.subjectTraits || '')).filter(Boolean)).slice(0, 3);
  const styles = uniqueStrings(rows.map((row) => String(row?.styleDescription || '')).filter(Boolean)).slice(0, 3);
  const settings = uniqueStrings(rows.map((row) => String(row?.sceneSetting || '')).filter(Boolean)).slice(0, 3);
  const base = String(summary || '').trim();
  return [
    base,
    subjects.length ? 'Subjects: ' + subjects.join(' / ') : '',
    settings.length ? 'Settings: ' + settings.join(' / ') : '',
    styles.length ? 'Styles: ' + styles.join(' / ') : '',
    'Semantic enhancement engine: ' + engineLabel,
  ].filter(Boolean).join(' ');
}

async function enhanceVideoParseWithImageAnalysis(summary, options = {}) {
  const rows = Array.isArray(summary?.parseRows) ? summary.parseRows : [];
  if (!rows.length) return summary;
  const runtime = resolveImageAnalysisRuntime(String(options.semanticEngine || 'clip-interrogator'));
  // cloud remote 的 commandLine 为空但 mode 为 'remote'；本地 wrapper 有 commandLine
  if (!runtime.commandLine && runtime.mode !== 'remote') return summary;
  const isRemote = runtime.mode === 'remote';
  const hasRemote = Boolean(runtime.remoteProvider && runtime.remoteModel && runtime.remoteEndpoint);

  const enhancedRows = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] && typeof rows[index] === 'object' ? rows[index] : {};
    const base64 = String(row.keyframeImageBase64 || '').trim();
    if (!base64) {
      enhancedRows.push(row);
      continue;
    }
    const mimeType = String(row.keyframeMimeType || 'image/jpeg').trim() || 'image/jpeg';
    const ext = imageExtensionFromMimeType(mimeType);
    const framePath = path.join(LOCAL_IMAGE_ANALYSIS_DIR, `${crypto.randomUUID()}-video-keyframe.${ext}`);
    try {
      await fs.mkdir(LOCAL_IMAGE_ANALYSIS_DIR, { recursive: true });
      await fs.writeFile(framePath, Buffer.from(base64, 'base64'));

      // 为视频分析构造更丰富的上下文：时间、运动、CV 推断
      const videoContextTags = uniqueStrings([
        ...(Array.isArray(row.visualKeywords) ? row.visualKeywords : []),
        `shot-${index + 1}`,
        row.cameraMovement ? `camera:${row.cameraMovement}` : '',
        row.sceneType ? `shotSize:${row.sceneType}` : '',
        row.cameraAngle ? `angle:${row.cameraAngle}` : '',
        `duration:${Number(row.duration || 0).toFixed(2)}s`,
        `time:${Number(row.startTime || 0).toFixed(2)}s-${Number(row.endTime || 0).toFixed(2)}s`,
        row.motionStrength ? `motion:${row.motionStrength}` : '',
      ].filter(Boolean));

      const analysisPayload = {
        name: `video-shot-${index + 1}.${ext}`,
        inputPath: framePath,
        inputMimeType: mimeType,
        width: Number(row.keyframeWidth || summary.width || 0) || 0,
        height: Number(row.keyframeHeight || summary.height || 0) || 0,
        sourceUrl: '',
        tags: videoContextTags,
        smartCategories: [],
        engine: runtime.resolved,
        // 传递云端路由信息以确保进入远程分析
        ...(isRemote && hasRemote ? {
          provider: runtime.remoteProvider,
          model: runtime.remoteModel,
        } : {}),
      };

      const imageAnalysis = await processLocalImageAnalyzeRequest(analysisPayload);
      enhancedRows.push({
        ...row,
        frameDescription: [
          String(imageAnalysis.subject || ''),
          String(imageAnalysis.scene || ''),
          String(imageAnalysis.style || ''),
          String(imageAnalysis.lighting || ''),
          String(row.frameDescription || ''),
        ].filter(Boolean).join(' '),
        imagePrompt: String(imageAnalysis.promptZh || row.imagePrompt || ''),
        keyframePrompt: String(imageAnalysis.promptZh || row.keyframePrompt || ''),
        styleDescription: String(imageAnalysis.style || row.styleDescription || ''),
        lighting: String(imageAnalysis.lighting || row.lighting || ''),
        lightingMood: String(imageAnalysis.lighting || row.lightingMood || ''),
        sceneSetting: String(imageAnalysis.scene || row.sceneSetting || ''),
        subjectSummary: String(imageAnalysis.subject || row.subjectSummary || ''),
        subjectTraits: String(imageAnalysis.summary || row.subjectTraits || ''),
        colorPalette: Array.isArray(imageAnalysis.palette) && imageAnalysis.palette.length ? imageAnalysis.palette : row.colorPalette,
        visualKeywords: uniqueStrings([
          ...(Array.isArray(row.visualKeywords) ? row.visualKeywords : []),
          ...(Array.isArray(imageAnalysis.keywords) ? imageAnalysis.keywords : []),
        ]).slice(0, 12),
      });
    } catch {
      enhancedRows.push(row);
    } finally {
      await fs.rm(framePath, { force: true }).catch(() => {});
    }
  }

  const engineLabel = isRemote
    ? `keyframe-video-analysis:${String(runtime.remoteModel || runtime.resolved)}`
    : `keyframe-image-analysis:${runtime.resolved}`;
  return {
    ...summary,
    parseRows: enhancedRows,
    suggestedShots: enhancedRows.map((row, index) => ({
      id: String(row.id || `shot-${index + 1}`),
      time: Number(row.keyframeTime || row.time || 0),
      label: `镜头 ${Number(row.shotNumber || index + 1)}`,
      shotSize: String(row.sceneType || row.shotSize || ''),
      cameraPrompt: String(row.cameraPrompt || ''),
      imagePrompt: String(row.imagePrompt || ''),
      keyframePrompt: String(row.keyframePrompt || ''),
    })),
    summary: buildEnhancedVideoParseSummary(summary?.summary, enhancedRows, engineLabel),
    analysisEngine: `${String(summary?.analysisEngine || '')}|semantic-upgrade:${runtime.resolved}`,
  };
}

async function runLocalSubtitleRemoval({
  inputPath,
  tempOutputPath,
  detectionMode,
  manualX,
  manualY,
  manualWidth,
  manualHeight,
  feather,
}) {
  await runPreferredLocalPython({
    scriptPath: LOCAL_VIDEO_REMOVE_SUBTITLE_SCRIPT,
    timeoutMs: Number(process.env.HMDAO_LOCAL_SUBTITLE_TIMEOUT_MS || 20000),
    args: [
      '--input',
      inputPath,
      '--output',
      tempOutputPath,
      '--mode',
      detectionMode,
      '--x',
      String(manualX),
      '--y',
      String(manualY),
      '--width',
      String(manualWidth),
      '--height',
      String(manualHeight),
      '--feather',
      String(feather),
    ],
  });
}

async function runDemucsAudioSplit({
  inputPath,
  requestId,
  outputPath,
  audioOutputPath,
  vocalOutputPath,
  accompanimentOutputPath,
  keepAudioInVideo,
}) {
  const demucsInputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-demucs-input.wav`);
  const demucsOutputDir = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-demucs`);
  await fs.rm(demucsOutputDir, { recursive: true, force: true }).catch(() => {});
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '2',
    '-ar',
    '44100',
    demucsInputPath,
  ]);
  await runPreferredLocalPython({
    scriptPath: null,
    args: [
      '-m',
      'demucs.separate',
      '-n',
      'htdemucs',
      '--two-stems',
      'vocals',
      '-o',
      demucsOutputDir,
      demucsInputPath,
    ],
  });
  const demucsBaseName = path.parse(demucsInputPath).name;
  const demucsStemDir = path.join(demucsOutputDir, 'htdemucs', demucsBaseName);
  const vocalWavPath = path.join(demucsStemDir, 'vocals.wav');
  const accompanimentWavPath = path.join(demucsStemDir, 'no_vocals.wav');
  await Promise.all([
    runCommand('ffmpeg', ['-y', '-i', demucsInputPath, '-acodec', 'pcm_s16le', audioOutputPath]),
    runCommand('ffmpeg', ['-y', '-i', vocalWavPath, '-acodec', 'pcm_s16le', vocalOutputPath]),
    runCommand('ffmpeg', ['-y', '-i', accompanimentWavPath, '-acodec', 'pcm_s16le', accompanimentOutputPath]),
  ]);
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    ...(keepAudioInVideo ? ['-i', vocalOutputPath] : []),
    ...(keepAudioInVideo ? ['-map', '0:v:0', '-map', '1:a:0'] : []),
    ...(keepAudioInVideo ? [] : ['-an']),
    ...buildWebmEncodeArgs(outputPath, { includeAudio: keepAudioInVideo }),
  ]);
  return {
    engine: 'demucs-v4',
    source: 'local-demucs',
  };
}

// ===== Florence-2 本地视觉分析运行时（托管安装）=====
// 让后端在每次解析时都能从托管清单把已安装的 Florence-2 路径、venv python、模型目录
// 注入 process.env，使「一键安装」在进程重启后依然生效，且 wrapper 走 venv python 而非系统 py。

// R1：把可能「指向目录（历史安装误存 backend 目录）」的 runtimePath 归一化为真正的 .py 推理脚本，
// 否则 buildRuntimeInvocation 会把目录当 Python 脚本跑 → PermissionError → 整条分析失败。

// P1-4: 在类 Unix 平台补充 Homebrew/系统 bin 目录候选（防止服务进程未继承完整 PATH）

// P3-1: 下载工具（支持断点续传）来自独立轻量模块，避免测试时拉起重型 server。
import { downloadFileWithProgress } from './runtime-download.mjs';

// P3-8: 完整性校验函数来自独立轻量模块（见 runtime-integrity.mjs），避免隐式依赖整个 server 模块。
import { verifyDownloadIntegrity } from './runtime-integrity.mjs';
// P3-4: 磁盘空间预检来自独立轻量模块（见 runtime-disk.mjs）。
import { assertEnoughDiskSpace, getAvailableDiskBytes, getDiskTotalBytes } from './runtime-disk.mjs';
// P3-9/P3-3: 回滚与旧版本清理逻辑来自独立轻量模块（见 runtime-rollback.mjs），避免测试时拉起整个 server。
import {
  buildManagedRuntimePaths,
  pruneOldBakBackups,
  configureRuntimeRollback,
  listManagedLocalPostBackups,
  rollbackManagedLocalPostRuntime,
  cleanupManagedLocalPostRuntimeTemp,
} from './runtime-rollback.mjs';

/**
 * 本地卸载托管运行时：删除安装目录（含自定义目录/中文路径）+ 下载缓存 + 清单条目 + 探测缓存。
 * 仅删除「本面板安装」的目录：默认托管目录，或清单里记录过 rootDir 的自定义目录。
 */
async function uninstallManagedLocalPostRuntime(runtimeKey) {
  const normalizedKey = String(runtimeKey || '').trim();
  if (!LOCAL_POST_INSTALLABLE_RUNTIMES[normalizedKey]) {
    throw new Error(`unsupported-runtime:${normalizedKey}`);
  }
  const entry = getManagedRuntimeManifestEntry(normalizedKey);
  const removedDirs = [];
  const candidateRoots = new Set();
  // 默认托管目录
  candidateRoots.add(buildManagedRuntimePaths(normalizedKey).rootDir);
  // 清单记录的自定义安装目录（仅当确为本面板安装记录时才允许删除）
  const recordedRoot = String(entry?.rootDir || '').trim();
  if (recordedRoot && path.isAbsolute(recordedRoot)) {
    candidateRoots.add(path.resolve(recordedRoot));
  }
  for (const rootDir of candidateRoots) {
    if (!rootDir || !existsSync(rootDir)) continue;
    // 双保险：目录内应有 current/staging 子目录之一，避免误删无关目录
    const looksManaged = existsSync(path.join(rootDir, 'current')) || existsSync(path.join(rootDir, 'staging'));
    const isDefaultRoot = isPathInsideDir(LOCAL_POST_MANAGED_RUNTIME_DIR, rootDir);
    if (!looksManaged && !isDefaultRoot) continue;
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    removedDirs.push(rootDir);
  }
  // 下载缓存
  const downloadDir = buildManagedRuntimePaths(normalizedKey).downloadDir;
  if (existsSync(downloadDir)) {
    await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    removedDirs.push(downloadDir);
  }
  await removeManagedRuntimeManifestEntry(normalizedKey);
  clearLocalPostRuntimeDetectionCache();
  const doctorReport = await buildLocalPostDoctorReport({ forceRelease: true }).catch(() => null);
  return {
    runtimeKey: normalizedKey,
    removedDirs,
    doctor: doctorReport?.runtimes?.[normalizedKey] || null,
  };
}

async function resolvePypiWheelAsset(packageName, preferredVersion = '') {
  const normalizedVersion = String(preferredVersion || '').trim();
  const urlsToTry = normalizedVersion
    ? [
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(normalizedVersion)}/json`,
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
    ]
    : [`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`];
  let payload = null;
  let lastError = '';
  for (const target of urlsToTry) {
    try {
      const response = await fetch(target, {
        headers: {
          'User-Agent': 'HMDAO Runtime Installer',
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      payload = await response.json().catch(() => null);
      if (payload) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!payload) {
    throw new Error(`pypi-metadata-failed:${packageName}:${lastError || 'unknown-error'}`);
  }
  // P1-3: 按当前平台 + CPU 架构选择匹配的 wheel 平台标签
  const info = buildPlatformInfo();
  const platformTagRe = selectPypiWheelPlatformRegex(info);
  const files = Array.isArray(payload?.urls) ? payload.urls : [];
  const ranked = files
    .filter((item) => item?.packagetype === 'bdist_wheel' && platformTagRe.test(String(item.filename || '')))
    .sort((left, right) => {
      const leftName = String(left?.filename || '');
      const rightName = String(right?.filename || '');
      const leftScore = /cp313/i.test(leftName) ? 2 : /cp31/i.test(leftName) ? 1 : 0;
      const rightScore = /cp313/i.test(rightName) ? 2 : /cp31/i.test(rightName) ? 1 : 0;
      return rightScore - leftScore;
    });
  const selected = ranked[0] || null;
  if (!selected?.url) {
    throw new Error(`wheel-not-found:${packageName}:${info.platform}-${info.arch}`);
  }
  return {
    version: String(payload?.info?.version || '').trim() || normalizedVersion,
    downloadUrl: String(selected.url || '').trim(),
    fileName: String(selected.filename || '').trim() || `${packageName}.whl`,
    releaseUrl: `https://pypi.org/project/${encodeURIComponent(packageName)}/${encodeURIComponent(String(payload?.info?.version || normalizedVersion || '').trim() || 'latest')}/`,
    // P3-8: 携带 PyPI 提供的 sha256 / 文件体积，供下载后完整性校验
    expectedSha256: String(selected?.digests?.sha256 || '').trim() || null,
    expectedSize: Number(selected?.size) > 0 ? Number(selected.size) : null,
  };
}

async function resolveLatestGmicInstallAsset() {
  const response = await fetch('https://gmic.eu/download.html', {
    headers: {
      'User-Agent': 'HMDAO Runtime Installer',
    },
  });
  if (!response.ok) {
    throw new Error(`gmic-download-page-failed:${response.status}`);
  }
  const text = await response.text();
  const match = text.match(/get_file\.php\?file=(windows\/gmic_([0-9.]+)_cli_win64\.zip)/i);
  if (!match?.[1] || !match?.[2]) {
    throw new Error('gmic-download-link-not-found');
  }
  return {
    version: match[2],
    downloadUrl: `https://gmic.eu/get_file.php?file=${match[1]}`,
    fileName: path.basename(match[1]),
    releaseUrl: 'https://gmic.eu/download.html',
  };
}

// yt-dlp 采用 onedir（目录式）构建，从 GitHub Releases 拉取最新版平台压缩包。
// 各平台资产名：Windows=yt-dlp_win.zip / macOS=yt-dlp_macos.zip / Linux=yt-dlp_linux.zip，
// 解压后内含 yt-dlp/ 目录（Windows 下为 yt-dlp/yt-dlp.exe）。onedir 可彻底消除 onefile 的
// 控制台闪窗（PyInstaller onefile 解压阶段不受 Node windowsHide 控制，会弹黑窗口）。
// 若 GitHub API 被限流/不可达，回退到已知稳定的版本直链，保证一键安装仍可用。
const YTDLP_FALLBACK_VERSION = '2026.07.04';
async function resolveLatestYtDlpInstallAsset() {
  const { assetName, fileName } = resolveYtDlpAssetNames();
  const assetNameLower = assetName.toLowerCase();
  try {
    const response = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: {
        'User-Agent': 'HMDAO Runtime Installer',
        Accept: 'application/vnd.github+json',
      },
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      if (payload && Array.isArray(payload.assets)) {
        const asset = payload.assets.find((item) => String(item?.name || '').toLowerCase() === assetNameLower);
        if (asset?.browser_download_url) {
          return {
            version: String(payload?.tag_name || '').trim() || firstSemverToken(String(payload?.tag_name || '')),
            downloadUrl: String(asset.browser_download_url || '').trim(),
            fileName,
            // 类 Unix 下载的裸二进制需要 +x 权限
            executableMode: !buildPlatformInfo().isWindows,
            releaseUrl: String(payload?.html_url || 'https://github.com/yt-dlp/yt-dlp/releases/latest').trim(),
            // P3-8: GitHub release 资产自带 sha256 digest 与 size，供下载后完整性校验
            expectedSha256: String(asset?.digest || '').trim() || null,
            expectedSize: Number(asset?.size) > 0 ? Number(asset.size) : null,
          };
        }
      }
    }
  } catch (_) {
    // 网络/解析异常时走下方兜底直链
  }
  return {
    version: YTDLP_FALLBACK_VERSION,
    downloadUrl: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_FALLBACK_VERSION}/${assetName}`,
    fileName,
    executableMode: !buildPlatformInfo().isWindows,
    releaseUrl: `https://github.com/yt-dlp/yt-dlp/releases/tag/${YTDLP_FALLBACK_VERSION}`,
    // P3-8: 兜底直链无来源校验和，完整性校验将自动跳过（仅做下载体积兜底）
    expectedSha256: null,
    expectedSize: null,
  };
}

// Aria2 跨平台压缩包：Windows=aria2-*.zip（内含 aria2c.exe）/ macOS=aria2-*.tar.bz2 / Linux=aria2-*.tar.bz2。
// 安装流程将其解压到 current 目录，并从 current 递归查找 aria2c 可执行文件。
function resolveAria2AssetNames() {
  const { isWindows, isMac } = buildPlatformInfo();
  if (isWindows) return { assetName: 'aria2-1.37.0-win-64bit-build1.zip', fileName: 'aria2-win.zip' };
  if (isMac) return { assetName: 'aria2-1.37.0-osx-darwin.tar.bz2', fileName: 'aria2-osx.tar.bz2' };
  return { assetName: 'aria2-1.37.0-linux-gnu-64bit-build1.tar.bz2', fileName: 'aria2-linux.tar.bz2' };
}

async function resolveLatestAria2InstallAsset() {
  const { assetName, fileName } = resolveAria2AssetNames();
  const want = String(assetName || '').toLowerCase();
  try {
    const response = await fetch('https://api.github.com/repos/aria2/aria2/releases/latest', {
      headers: { 'User-Agent': 'HMDAO Runtime Installer', Accept: 'application/vnd.github+json' },
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      if (payload && Array.isArray(payload.assets)) {
        const asset = payload.assets.find((item) => String(item?.name || '').toLowerCase() === want);
        if (asset?.browser_download_url) {
          return {
            version: String(payload?.tag_name || '').replace(/^v/i, '').trim() || '1.37.0',
            downloadUrl: String(asset.browser_download_url || '').trim(),
            fileName,
            releaseUrl: String(payload?.html_url || 'https://github.com/aria2/aria2/releases/latest').trim(),
            expectedSha256: String(asset?.digest || '').trim() || null,
            expectedSize: Number(asset?.size) > 0 ? Number(asset.size) : null,
          };
        }
      }
    }
  } catch (_) { /* 走兜底 */ }
  // 兜底：直接用已知稳定版资产直链
  const version = '1.37.0';
  return {
    version,
    downloadUrl: `https://github.com/aria2/aria2/releases/download/release-${version}/${assetName}`,
    fileName,
    releaseUrl: `https://github.com/aria2/aria2/releases/tag/release-${version}`,
    expectedSha256: null,
    expectedSize: null,
  };
}

// 扩展采集链路零配置：服务启动时对下载类运行时（yt-dlp / aria2 / ffmpeg）自动静默安装。
// 仅当该运行时处于「可安装 + 木安装 + 没有进行中的任务」时才触发，避免重复安装或干扰手动操作。
const AUTO_INSTALL_RUNTIME_KEYS = ['ytdlp', 'aria2', 'ffmpeg'];
let autoInstallBootstrapDone = false;
async function bootstrapAutoInstallLocalPostRuntimes() {
  if (autoInstallBootstrapDone) return;
  autoInstallBootstrapDone = true;
  const resolvers = {
    ytdlp: resolveLocalPostYtDlpBackend,
    aria2: resolveLocalPostAria2Backend,
    ffmpeg: resolveLocalPostFfmpegBackend,
  };
  for (const key of AUTO_INSTALL_RUNTIME_KEYS) {
    try {
      const resolve = resolvers[key];
      if (!resolve) continue;
      const status = resolve();
      if (status?.configured) continue;
      const job = await startRuntimeInstallJob(key);
      if (job) {
        console.log(`[local-post] 自动静默安装 ${key}（后台任务 ${job.jobId}）`);
      }
    } catch (err) {
      console.warn(`[local-post] 自动安装 ${key} 触发失败:`, err?.message || err);
    }
  }
}
function resolveFfmpegAssetNames() {
  const { isWindows, isMac } = buildPlatformInfo();
  if (isWindows) return { assetName: 'ffmpeg-master-latest-win64-gpl.zip', fileName: 'ffmpeg-win.zip' };
  if (isMac) return { assetName: 'ffmpeg-master-latest-macos64-gpl.zip', fileName: 'ffmpeg-osx.zip' };
  return { assetName: 'ffmpeg-master-latest-linux64-gpl.tar.xz', fileName: 'ffmpeg-linux.tar.xz' };
}

async function resolveLatestFfmpegInstallAsset() {
  const { assetName, fileName } = resolveFfmpegAssetNames();
  const want = String(assetName || '').toLowerCase();
  try {
    const response = await fetch('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest', {
      headers: { 'User-Agent': 'HMDAO Runtime Installer', Accept: 'application/vnd.github+json' },
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      if (payload && Array.isArray(payload.assets)) {
        const asset = payload.assets.find((item) => String(item?.name || '').toLowerCase() === want);
        if (asset?.browser_download_url) {
          return {
            version: String(payload?.tag_name || '').trim() || 'master',
            downloadUrl: String(asset.browser_download_url || '').trim(),
            fileName,
            releaseUrl: String(payload?.html_url || 'https://github.com/BtbN/FFmpeg-Builds/releases/latest').trim(),
            expectedSha256: String(asset?.digest || '').trim() || null,
            expectedSize: Number(asset?.size) > 0 ? Number(asset.size) : null,
          };
        }
      }
    }
  } catch (_) { /* 走兜底 */ }
  return {
    version: 'master',
    downloadUrl: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${assetName}`,
    fileName,
    releaseUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest',
    expectedSha256: null,
    expectedSize: null,
  };
}

async function resolveLatestOcioConfigAsset() {
  const response = await fetch('https://api.github.com/repos/AcademySoftwareFoundation/OpenColorIO-Config-ACES/releases/latest', {
    headers: {
      'User-Agent': 'HMDAO Runtime Installer',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`ocio-config-release-failed:${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  const matched = assets.find((asset) => /^cg-config-.*_ocio-v2\.5\.ocio$/i.test(String(asset?.name || '').trim()));
  if (!matched?.browser_download_url) {
    throw new Error('ocio-config-asset-not-found');
  }
  return {
    version: String(payload?.tag_name || '').replace(/^v/i, '').trim(),
    downloadUrl: String(matched.browser_download_url || '').trim(),
    fileName: String(matched.name || '').trim() || 'cg-config.ocio',
    releaseUrl: String(payload?.html_url || '').trim(),
    // P3-8: GitHub release 资产自带 sha256 digest 与 size，供下载后完整性校验
    expectedSha256: String(matched?.digest || '').trim() || null,
    expectedSize: Number(matched?.size) > 0 ? Number(matched.size) : null,
  };
}

async function resolveInstallableRuntimeAsset(runtimeKey) {
  if (runtimeKey === 'florence2') {
    // Florence-2 不是预编译二进制，而是 Python ML 运行时：一键安装会创建 venv、pip 安装
    // PyTorch/Transformers 并下载 HF 模型权重。这里只返回「版本 + 预期体积」，供面板展示与磁盘校验。
    const latest = await fetchLatestLocalPostRuntimeVersion('florence2');
    const layout = buildManagedRuntimePaths('florence2');
    const python = detectManagedLocalPostFlorence2Python() || 'python3';
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.florence2.runtimeName,
      sourceLabel: latest.sourceLabel || 'Hugging Face / PyPI',
      archiveType: 'ml-model',
      version: latest.latestVersion || latest.pinnedVersion,
      downloadUrl: '',
      expectedSize: 3 * 1024 * 1024 * 1024, // 权重 + Python 虚拟环境 + 依赖合计约 3GB
      pythonPath: python,
      backendDir: path.join(layout.rootDir, 'backend'),
      modelDir: path.join(layout.rootDir, 'model'),
    };
  }
  if (runtimeKey === 'gmic') {
    // P1-6: gmic.eu 官方只发布 Windows CLI zip；非 Windows 一键安装会装进 PE 二进制导致自检失败，直接给出可读指引
    const gmicSupport = gmicManagedInstallSupport();
    if (!gmicSupport.supported) {
      throw new Error(`gmic-managed-install-unsupported:${process.platform}。${gmicSupport.hint}`);
    }
    const asset = await resolveLatestGmicInstallAsset();
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.gmic.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.gmic.sourceLabel,
      archiveType: 'zip',
      ...asset,
    };
  }
  if (runtimeKey === 'oiio') {
    const latest = await fetchLatestLocalPostRuntimeVersion('oiio');
    const asset = await resolvePypiWheelAsset('OpenImageIO', latest.latestVersion || '');
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.oiio.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.oiio.sourceLabel,
      archiveType: 'wheel',
      ...asset,
    };
  }
  if (runtimeKey === 'ocio') {
    const latest = await fetchLatestLocalPostRuntimeVersion('ocio');
    const runtimeAsset = await resolvePypiWheelAsset('opencolorio', latest.latestVersion || '');
    const configAsset = await resolveLatestOcioConfigAsset();
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.ocio.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.ocio.sourceLabel,
      archiveType: 'wheel',
      ...runtimeAsset,
      configAsset,
    };
  }
  if (runtimeKey === 'ytdlp') {
    const asset = await resolveLatestYtDlpInstallAsset();
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.ytdlp.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.ytdlp.sourceLabel,
      archiveType: 'zip',
      ...asset,
    };
  }
  if (runtimeKey === 'aria2') {
    const asset = await resolveLatestAria2InstallAsset();
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.aria2.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.aria2.sourceLabel,
      archiveType: 'zip',
      ...asset,
    };
  }
  if (runtimeKey === 'ffmpeg') {
    const asset = await resolveLatestFfmpegInstallAsset();
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.ffmpeg.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.ffmpeg.sourceLabel,
      archiveType: 'zip',
      ...asset,
    };
  }
  throw new Error(`unsupported-runtime:${runtimeKey}`);
}

async function verifyManagedRuntimeInstall(runtimeKey, details = {}) {
  if (runtimeKey === 'gmic') {
    const version = await detectInstalledRuntimeVersion(String(details.executablePath || ''), [{ args: ['version'] }, { args: ['--version'] }, { args: ['-version'] }]);
    return {
      ok: Boolean(version?.ok),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: '',
    };
  }
  if (runtimeKey === 'oiio') {
    const version = await detectInstalledRuntimeVersion(String(details.executablePath || ''), [{ args: ['--version'] }]);
    return {
      ok: Boolean(version?.ok),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: String(details.configPath || '').trim(),
    };
  }
  if (runtimeKey === 'ocio') {
    const version = await detectOcioRuntimeInstallation(String(details.runtimePath || ''));
    return {
      ok: Boolean(version?.ok) && Boolean(String(details.configPath || '').trim() && existsSync(String(details.configPath || '').trim())),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: String(details.configPath || '').trim(),
    };
  }
  if (runtimeKey === 'ytdlp') {
    const version = await detectInstalledRuntimeVersion(String(details.executablePath || ''), [{ args: ['--version'] }]);
    return {
      ok: Boolean(version?.ok),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: '',
    };
  }
  if (runtimeKey === 'aria2') {
    const version = await detectInstalledRuntimeVersion(String(details.executablePath || ''), [{ args: ['--version'] }]);
    return {
      ok: Boolean(version?.ok),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: '',
    };
  }
  if (runtimeKey === 'ffmpeg') {
    const version = await detectInstalledRuntimeVersion(String(details.executablePath || ''), [{ args: ['-version'] }]);
    return {
      ok: Boolean(version?.ok),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: '',
    };
  }
  if (runtimeKey === 'florence2') {
    const entry = getManagedRuntimeManifestEntry('florence2');
    const runtimePath = entry?.runtimePath || String(details.executablePath || '');
    const pythonPath = entry?.pythonPath || detectManagedLocalPostFlorence2Python();
    const modelDir = entry?.hfHome || '';
    let ok = Boolean(runtimePath) && existsSync(runtimePath);
    let probe = null;
    if (ok) {
      try {
        probe = await runViaShell(pythonPath || 'python3', [
          '-c',
          'import torch, transformers; print("ok")',
        ], { cwd: path.dirname(runtimePath), timeoutMs: 60 * 1000 });
        ok = probe.exitCode === 0;
      } catch (_) {
        ok = false;
      }
    }
    return {
      ok,
      installedVersion: String(entry?.version || '').trim(),
      probe,
      configPath: modelDir,
    };
  }
  return {
    ok: false,
    installedVersion: '',
    probe: null,
    configPath: '',
  };
}

async function findSystemPython() {
  for (const candidate of ['python3', 'python', 'py']) {
    try {
      const probe = candidate === 'py' ? ['-3', '--version'] : ['--version'];
      const res = await runViaShell(candidate, probe, { cwd: process.cwd() });
      if (res.exitCode === 0) return candidate;
    } catch (_) {}
  }
  return '';
}

async function installFlorence2Runtime(runtimeKey, layout, asset, job, runtimeMeta) {
  const rootDir = layout.rootDir;
  const backendDir = asset.backendDir || path.join(rootDir, 'backend');
  const modelDir = asset.modelDir || path.join(rootDir, 'model');
  const venvDir = path.join(rootDir, 'venv');
  await fs.mkdir(backendDir, { recursive: true });
  await fs.mkdir(modelDir, { recursive: true });

  // 1) 定位系统 Python
  updateRuntimeInstallJob(job, { stage: 'resolve', progress: 12, message: '正在定位 Python 运行时' });
  const pyCmd = await findSystemPython();
  if (!pyCmd) {
    throw new Error('未检测到 Python，请先安装 Python 3.10+ 并加入 PATH 后重试');
  }

  const isWin = buildPlatformInfo().isWindows;
  const venvPython = path.join(venvDir, isWin ? 'Scripts/python.exe' : 'bin/python');
  const venvPip = path.join(venvDir, isWin ? 'Scripts/pip.exe' : 'bin/pip');

  // 2) 复用已存在的 venv（断点续传：上次中断若已装好 torch/transformers，跳过重复下载约 1GB）
  const venvAlreadyReady = existsSync(venvPython)
    && await runViaShell(venvPython, ['-c', 'import torch, transformers, einops, timm; print(1)'], { cwd: rootDir, timeoutMs: 120000 })
      .then((r) => r.exitCode === 0).catch(() => false);

  if (venvAlreadyReady) {
    updateRuntimeInstallJob(job, { stage: 'prepare', progress: 50, message: '检测到已安装依赖，跳过重复下载（约 1GB）' });
  } else {
    updateRuntimeInstallJob(job, { stage: 'prepare', progress: 16, message: '正在创建 Python 虚拟环境' });
    await runViaShell(pyCmd, ['-m', 'venv', venvDir], { cwd: rootDir, timeoutMs: LOCAL_POST_INSTALL_STEP_TIMEOUT_MS });

    // 3) 安装 PyTorch(CPU) / Transformers / Pillow / huggingface_hub（固定已知良好版本，确保「最新稳定」）
    //    国内网络用清华镜像，避免 PyPI / PyTorch 官方源超时或被墙。
    const pipIndex = process.env.HMDAO_PIP_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple';
    // 注意：清华/中科大等 PyTorch 镜像未同步 cp313/cp314 的 torch 轮子，必须走官方 CPU 索引（国内可达）。
    const torchIndex = process.env.HMDAO_TORCH_INDEX || 'https://download.pytorch.org/whl/cpu';
    updateRuntimeInstallJob(job, { stage: 'dependencies', progress: 24, message: '正在安装 PyTorch / Transformers 依赖（约 1GB，请耐心等待）' });
    await runViaShell(venvPip, ['install', '--upgrade', 'pip', '-i', pipIndex], { cwd: rootDir, timeoutMs: LOCAL_POST_INSTALL_STEP_TIMEOUT_MS });
    await runViaShell(venvPip, [
      'install',
      'torch==2.9.0',
      'torchvision==0.24.0',
      '--index-url', torchIndex,
    ], { cwd: rootDir, timeoutMs: LOCAL_POST_INSTALL_STEP_TIMEOUT_MS });
    await runViaShell(venvPip, [
      'install',
      'transformers==4.51.3',
      'Pillow==11.3.0',
      'huggingface_hub==0.30.2',
      'numpy==1.26.4',
      // Florence-2 的 trust_remote_code 模型代码（modeling_florence2.py）运行时依赖 einops/timm，
      // 缺少会在推理阶段报 ImportError，必须随安装一并装好。
      'einops==0.8.2',
      'timm==1.0.28',
      '-i', pipIndex,
    ], { cwd: rootDir, timeoutMs: LOCAL_POST_INSTALL_STEP_TIMEOUT_MS });
  }

  // 4) 放置 Florence-2 推理脚本（仓库内自带，无需下载）
  updateRuntimeInstallJob(job, { stage: 'prepare', progress: 48, message: '正在部署 Florence-2 推理脚本' });
  const repoBackend = path.join(APP_DIR, 'server');
  for (const f of ['local_image_example_florence2.py', 'local_image_runtime_examples.py']) {
    const src = path.join(repoBackend, f);
    if (existsSync(src)) {
      await fs.copyFile(src, path.join(backendDir, f));
    }
  }
  const runtimePyPath = path.join(backendDir, 'local_image_example_florence2.py');

  // 5) 预下载 Florence-2-large 权重到独立模型目录（HF_ENDPOINT 走国内镜像，避免 huggingface.co 被墙）
  //    注意：huggingface_hub>=0.26 已移除 `python -m huggingface_hub snapshot_download` 与 --local-dir-use-symlinks，
  //    改用 `huggingface-cli download`（venv 内的可执行脚本）。
  updateRuntimeInstallJob(job, { stage: 'download', progress: 54, message: '正在下载 Florence-2-large 权重（约 2.3GB，国内走 hf-mirror 镜像）' });
  const hfEndpoint = process.env.HMDAO_HF_ENDPOINT || 'https://hf-mirror.com';
  const hfCli = path.join(venvDir, isWin ? 'Scripts/huggingface-cli.exe' : 'bin/huggingface-cli');
  const dl = await runViaShell(hfCli, [
    'download',
    'microsoft/Florence-2-large',
    '--local-dir', modelDir,
  ], {
    cwd: rootDir,
    timeoutMs: LOCAL_POST_INSTALL_STEP_TIMEOUT_MS,
    extraEnv: {
      HF_ENDPOINT: hfEndpoint,
      HF_HOME: modelDir,
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      HF_HUB_ENABLE_HF_TRANSFER: '0',
    },
  });
  if (!dl.ok || dl.exitCode !== 0) {
    throw new Error('Florence-2 权重下载失败：' + (dl.stderr || dl.stdout || 'unknown').toString().slice(0, 500));
  }

  // 6) 自检：venv 内能否 import transformers / torch
  updateRuntimeInstallJob(job, { stage: 'integrity', progress: 86, message: '正在校验 Florence-2 运行环境' });
  await verifyFlorence2Runtime(runtimePyPath, venvPython, modelDir);

  // 7) 写入托管清单 + 当前进程环境变量，确保立即可用且重启后自动恢复
  updateRuntimeInstallJob(job, { stage: 'finalize', progress: 94, message: '正在写入运行时配置' });
  persistManagedRuntimeManifestEntry('florence2', {
    runtimeKey: 'florence2',
    runtimeName: runtimeMeta.runtimeName,
    runtimePath: runtimePyPath,
    pythonPath: venvPython,
    hfHome: modelDir,
    version: String(asset.version || '').trim(),
    installedAt: new Date().toISOString(),
  });
  process.env.HMDAO_FLORENCE2_PATH = runtimePyPath;
  process.env.HMDAO_FLORENCE2_PYTHON = venvPython;
  process.env.HMDAO_FLORENCE2_HF_HOME = modelDir;
  // 推理脚本用本地目录直接 from_pretrained，避免再去 Hugging Face 拉取（离线必中）
  process.env.HMDAO_FLORENCE2_MODEL = modelDir;
  applyManagedFlorence2Env();

  updateRuntimeInstallJob(job, {
    stage: 'done',
    progress: 100,
    status: 'done',
    installedVersion: String(asset.version || '').trim(),
    message: 'Florence-2 已安装完成，图片/视频分析将使用真实模型输出。',
  });
  return { installedVersion: String(asset.version || '').trim() };
}

async function verifyFlorence2Runtime(runtimePyPath, venvPython, modelDir) {
  if (!existsSync(runtimePyPath)) {
    throw new Error('Florence-2 推理脚本缺失，安装未完成');
  }
  const probe = await runViaShell(venvPython, [
    '-c',
    'import torch, transformers, huggingface_hub, einops, timm; import importlib.metadata as m; '
    + 'print("OK", m.version("transformers"), m.version("torch"))',
  ], { cwd: path.dirname(runtimePyPath), timeoutMs: 2 * 60 * 1000 }).catch((error) => ({ exitCode: 1, stderr: String(error) }));
  if (probe.exitCode !== 0) {
    throw new Error(`Florence-2 依赖校验失败: ${trimDiagnosticText(probe.stderr || '', 200)}`);
  }
  if (!existsSync(modelDir) || (await fs.readdir(modelDir)).length === 0) {
    throw new Error('Florence-2 模型权重目录为空，下载可能未成功');
  }
}

async function installManagedLocalPostRuntime(runtimeKey, job) {
  const runtimeMeta = LOCAL_POST_INSTALLABLE_RUNTIMES[runtimeKey];
  if (!runtimeMeta) {
    throw new Error(`unsupported-runtime:${runtimeKey}`);
  }
  const layout = buildManagedRuntimePaths(runtimeKey, job.targetDir);
  await fs.mkdir(layout.downloadDir, { recursive: true });
  await fs.mkdir(layout.rootDir, { recursive: true });
  await fs.rm(layout.stagingDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(layout.stagingDir, { recursive: true });

  updateRuntimeInstallJob(job, {
    status: 'running',
    stage: 'resolve',
    progress: 5,
    runtimeName: runtimeMeta.runtimeName,
    message: '正在解析最新版安装包',
  });
  const asset = await resolveInstallableRuntimeAsset(runtimeKey);
  updateRuntimeInstallJob(job, {
    sourceLabel: asset.sourceLabel,
    targetVersion: String(asset.version || '').trim(),
    releaseUrl: String(asset.releaseUrl || '').trim(),
    downloadUrl: String(asset.downloadUrl || '').trim(),
  });

  // P3-4: 下载前校验目标盘剩余空间，避免下载/解压中途因空间不足失败（半截文件难清理）。
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const archiveBytes = Number(asset.expectedSize) || 0;
  const configBytes = Number(asset.configAsset?.expectedSize) || 0;
  // 峰值占用 ≈ 下载包 + 解压展开(约 3x 体积) + 配置包；来源未知体积时给 2GB 安全下限，不盲填磁盘。
  const requiredBytes = (archiveBytes > 0 || configBytes > 0)
    ? Math.ceil((archiveBytes + configBytes) * 4) + 256 * MB
    : 2 * GB;
  const disk = await assertEnoughDiskSpace(layout.rootDir, requiredBytes, { label: runtimeMeta.runtimeName });
  updateRuntimeInstallJob(job, {
    freeSpaceBytes: disk.freeBytes,
    requiredSpaceBytes: requiredBytes,
  });

  // Florence-2：不走「下载预编译包」路径，而是创建 Python 虚拟环境 + 安装依赖 + 下载模型权重
  if (asset.archiveType === 'ml-model') {
    return await installFlorence2Runtime(runtimeKey, layout, asset, job, runtimeMeta);
  }

  const archivePath = path.join(layout.downloadDir, asset.fileName);
  updateRuntimeInstallJob(job, {
    stage: 'download',
    progress: 10,
    message: '正在下载安装包',
  });
  await downloadFileWithProgress(asset.downloadUrl, archivePath, ({ percent }) => {
    updateRuntimeInstallJob(job, {
      stage: 'download',
      progress: percent > 0 ? Math.min(48, 10 + Math.round(percent * 0.38)) : 18,
      message: percent > 0 ? `正在下载安装包 ${percent}%` : '正在下载安装包',
    });
  });

  // P3-8: 下载完毕即做完整性校验（hash/size）。损坏/被截断的安装包在解压与版本切换前被拦截，避免装进半成品。
  updateRuntimeInstallJob(job, {
    stage: 'integrity',
    progress: 52,
    message: '正在校验安装包完整性',
  });
  await verifyDownloadIntegrity(archivePath, {
    expectedSha256: asset.expectedSha256 || null,
    expectedSize: asset.expectedSize || null,
  });

  updateRuntimeInstallJob(job, {
    stage: 'extract',
    progress: 55,
    message: asset.archiveType === 'raw' ? '正在准备运行时' : '正在解压运行时',
  });
  if (asset.archiveType === 'raw') {
    // 裸二进制：按平台落地文件名（Windows=yt-dlp.exe / 类 Unix=yt-dlp）
    const targetExe = path.join(layout.stagingDir, asset.fileName || 'yt-dlp');
    await fs.mkdir(layout.stagingDir, { recursive: true });
    await fs.copyFile(archivePath, targetExe);
  } else {
    await extractZipArchiveToDirectory(archivePath, layout.stagingDir);
  }

  // P1-3: 类 Unix 平台为可执行文件补 +x 权限（下载的裸二进制 / 解压后丢失权限位）
  const ensureUnixExecutable = async (execPath) => {
    if (!execPath || buildPlatformInfo().isWindows) return;
    try { await fs.chmod(execPath, 0o755); } catch { /* best-effort */ }
  };

  let manifestEntry = null;
  if (runtimeKey === 'gmic') {
    const executablePath = findFileRecursively(layout.stagingDir, platformExecutableCandidates('gmic'));
    if (!executablePath) throw new Error('gmic-executable-missing-after-extract');
    await ensureUnixExecutable(executablePath);
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, executablePath)),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  } else if (runtimeKey === 'oiio') {
    const executablePath = findFileRecursively(layout.stagingDir, platformExecutableCandidates('oiiotool'));
    if (!executablePath) throw new Error('oiio-executable-missing-after-extract');
    await ensureUnixExecutable(executablePath);
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, executablePath)),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  } else if (runtimeKey === 'ocio') {
    const runtimePath = findFileRecursively(layout.stagingDir, platformExecutableCandidates('ocioconvert'));
    if (!runtimePath) throw new Error('ocio-executable-missing-after-extract');
    await ensureUnixExecutable(runtimePath);
    const configDir = path.join(layout.rootDir, 'configs');
    const configAsset = asset.configAsset || null;
    if (!configAsset?.downloadUrl) throw new Error('ocio-config-download-missing');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, configAsset.fileName);
    updateRuntimeInstallJob(job, {
      stage: 'config',
      progress: 70,
      message: '正在下载官方 ACES 配置',
    });
    await downloadFileWithProgress(configAsset.downloadUrl, configPath, ({ percent }) => {
      updateRuntimeInstallJob(job, {
        stage: 'config',
        progress: percent > 0 ? Math.min(84, 70 + Math.round(percent * 0.14)) : 74,
        message: percent > 0 ? `正在下载官方 ACES 配置 ${percent}%` : '正在下载官方 ACES 配置',
      });
    });
    // P3-8: OCIO 配置包同样校验完整性（GitHub release 自带 sha256/size）
    await verifyDownloadIntegrity(configPath, {
      expectedSha256: configAsset.expectedSha256 || null,
      expectedSize: configAsset.expectedSize || null,
    });
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      runtimePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, runtimePath)),
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, runtimePath)),
      configPath,
      configVersion: String(configAsset.version || '').trim(),
      configReleaseUrl: String(configAsset.releaseUrl || '').trim(),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  } else if (runtimeKey === 'ytdlp') {
    const executablePath = findFileRecursively(layout.stagingDir, platformExecutableCandidates('yt-dlp'));
    if (!executablePath) throw new Error('ytdlp-executable-missing-after-prepare');
    await ensureUnixExecutable(executablePath);
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, executablePath)),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  } else if (runtimeKey === 'aria2') {
    const executablePath = findFileRecursively(layout.stagingDir, platformExecutableCandidates('aria2c'));
    if (!executablePath) throw new Error('aria2-executable-missing-after-prepare');
    await ensureUnixExecutable(executablePath);
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, executablePath)),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  } else if (runtimeKey === 'ffmpeg') {
    const executablePath = findFileRecursively(layout.stagingDir, platformExecutableCandidates('ffmpeg'));
    if (!executablePath) throw new Error('ffmpeg-executable-missing-after-prepare');
    await ensureUnixExecutable(executablePath);
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, executablePath)),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  }

  // 记录安装根目录（含自定义目录，兼容中文路径）：更新/卸载时据此定位原位置
  if (manifestEntry) {
    manifestEntry.rootDir = layout.rootDir;
  }

  updateRuntimeInstallJob(job, {
    stage: 'switch',
    progress: 86,
    message: '正在切换到新版本',
  });
  // P3-9 支撑：把当前版本清单写入 staging，使其随 current 一并进入 .bak 备份，
  // 回滚时即可据此精确恢复 manifest 条目（版本号、可执行路径、rootDir 等）。
  if (manifestEntry) {
    await fs.writeFile(
      path.join(layout.stagingDir, '.hmdao-runtime-meta.json'),
      JSON.stringify({
        runtimeKey: manifestEntry.runtimeKey,
        runtimeName: manifestEntry.runtimeName,
        installedVersion: manifestEntry.version,
        sourceLabel: manifestEntry.sourceLabel,
        downloadUrl: manifestEntry.downloadUrl,
        releaseUrl: manifestEntry.releaseUrl,
        rootDir: manifestEntry.rootDir,
        executablePath: manifestEntry.executablePath,
        configPath: manifestEntry.configPath || '',
        configVersion: manifestEntry.configVersion || '',
        installedAt: manifestEntry.installedAt,
      }, null, 2),
    );
  }

  await replaceDirectoryContents(layout.currentDir, layout.stagingDir);
  await persistManagedRuntimeManifestEntry(runtimeKey, manifestEntry);
  clearLocalPostRuntimeDetectionCache();

  updateRuntimeInstallJob(job, {
    stage: 'verify',
    progress: 92,
    message: '正在执行安装后一键自检',
  });
  const verifyResult = await verifyManagedRuntimeInstall(runtimeKey, manifestEntry);
  if (!verifyResult.ok) {
    throw new Error(`runtime-verify-failed:${runtimeKey}`);
  }
  const doctorReport = await buildLocalPostDoctorReport({ forceRelease: true }).catch(() => null);
  // ★2026-09-01 修复（"安装任务假成功"根因）：
  //   旧代码只校验 verifyResult.ok，随后【无条件】写 status:'succeeded' + verified:true +
  //   "已通过本机自检"，完全不看刚生成的 doctorReport。结果出现自相矛盾的 job：
  //     status:succeeded / verified:true / "已通过自检"
  //     doctor.status:error / "yt-dlp.exe was not detected"
  //   前端与用户被误导（以为装好了，实际接口仍 503）。
  //   改为【以 doctor 实际检测为准】：doctor 检测到可执行文件才算成功，否则标 failed
  //   并给出可读原因（区分"下载成功但检测失败"与"下载失败"）。
  const doctorEntry = doctorReport?.runtimes?.[runtimeKey] || null;
  const detected = !!String(doctorEntry?.detectedPath || '').trim();
  updateRuntimeInstallJob(job, {
    status: detected ? 'succeeded' : 'failed',
    stage: 'done',
    progress: 100,
    message: detected
      ? '安装完成，并已通过本机自检'
      : `安装文件已下载，但自检未检测到可执行文件：${doctorEntry?.summary || 'not detected'}`,
    verified: detected,
    error: detected ? '' : String(doctorEntry?.summary || `runtime-not-detected:${runtimeKey}`),
    installedVersion: detected ? (verifyResult.installedVersion || manifestEntry?.version || '') : '',
    doctor: doctorEntry,
    completedAt: Date.now(),
  });
}

// P3-11：全局串行安装队列（来自独立轻量模块，便于单测）。
import {
  enqueueManagedRuntimeInstall,
  isJobStillQueued,
  configureRuntimeInstallQueue,
} from './runtime-install-queue.mjs';

async function startRuntimeInstallJob(runtimeKey, { requestedAction = 'install', targetDir = '' } = {}) {
  const normalizedKey = String(runtimeKey || '').trim();
  if (!LOCAL_POST_INSTALLABLE_RUNTIMES[normalizedKey]) {
    throw new Error(`unsupported-runtime:${normalizedKey}`);
  }
  // 校验自定义安装目录：仅允许绝对路径，且禁止写入系统/源目录
  let safeTargetDir = '';
  if (targetDir && String(targetDir).trim()) {
    const resolved = path.resolve(String(targetDir).trim());
    if (!path.isAbsolute(resolved)) {
      throw new Error('target-dir-must-be-absolute');
    }
    // P1-6: 按平台防护系统目录（Windows / macOS / Linux），并始终禁止写入应用自身目录
    if (isForbiddenInstallTarget(resolved, buildPlatformInfo(), [path.resolve(APP_DIR)])) {
      throw new Error('target-dir-not-allowed');
    }
    safeTargetDir = resolved;
  }
  // 更新时未显式传目录 → 复用上次安装的自定义目录（保持用户统一管理位置，含中文路径）
  if (!safeTargetDir) {
    const priorRootDir = String(getManagedRuntimeManifestEntry(normalizedKey)?.rootDir || '').trim();
    if (priorRootDir && path.isAbsolute(priorRootDir)) {
      safeTargetDir = path.resolve(priorRootDir);
    }
  }
  const existing = getLatestRuntimeInstallJob(normalizedKey);
  // 防止「卡在 pending 的旧任务」永久阻塞一键安装：超过 60s 未推进的旧任务视为失效，允许重触发。
  const STALE_JOB_MS = 60 * 1000;
  const isStaleJob = (job) => {
    if (!job) return false;
    if (job.status !== 'pending' && job.status !== 'running') return false;
    const startedAt = Number(job.startedAt || job.updatedAt || 0);
    return Date.now() - startedAt > STALE_JOB_MS;
  };
  if (existing && (existing.status === 'pending' || existing.status === 'running') && !isStaleJob(existing)) {
    return existing;
  }
  const runtimeMeta = LOCAL_POST_INSTALLABLE_RUNTIMES[normalizedKey];
  const job = {
    id: crypto.randomUUID(),
    runtimeKey: normalizedKey,
    runtimeName: runtimeMeta.runtimeName,
    requestedAction,
    targetDir: safeTargetDir,
    status: 'pending',
    stage: 'queued',
    progress: 0,
    message: '安装任务已排队',
    error: '',
    sourceLabel: runtimeMeta.sourceLabel,
    targetVersion: '',
    installedVersion: '',
    verified: false,
    doctor: null,
    releaseUrl: '',
    downloadUrl: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: 0,
  };
  updateRuntimeInstallJob(job);
  let settled = false;
  const runInstall = async () => {
    if (settled) return;
    settled = true;
    job.started = true;
    try {
      await installManagedLocalPostRuntime(normalizedKey, job);
    } catch (error) {
      updateRuntimeInstallJob(job, {
        status: 'failed',
        stage: 'failed',
        progress: Math.max(1, Number(job.progress || 0)),
        error: trimDiagnosticText(error instanceof Error ? error.message : String(error), 320),
        message: '安装失败，请查看错误信息后重试',
        completedAt: Date.now(),
      });
      await fs.rm(buildManagedRuntimePaths(normalizedKey).stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  };
  // P3-11：入队串行启动。runInstall 内部已 try/catch，故不会向外抛，队列会安全地推进下一个任务。
  enqueueManagedRuntimeInstall(runInstall, job);
  // watchdog：仅当任务既未启动、也不在队列中（疑似队列丢失）时才判定失败，
  // 避免排队等待中的任务被误杀（前一个安装可能耗时 >15s）。
  setTimeout(() => {
    if (job.status === 'pending' && !job.started && !isJobStillQueued(job)) {
      updateRuntimeInstallJob(job, {
        status: 'failed',
        stage: 'failed',
        progress: Math.max(1, Number(job.progress || 0)),
        error: 'install-job-did-not-start',
        message: '安装任务未能启动，请重试',
        completedAt: Date.now(),
      });
    }
  }, 15000).unref?.();
  return job;
}

// P1-11：以下 7 个函数已抽取至 lib/runtime-version-utils.mjs。
import {
  compareVersionStrings,
  detectInstalledRuntimeVersion,
  detectOcioRuntimeInstallation,
  firstSemverToken,
  runLocalPostDiagnosticCommand,
  trimDiagnosticText,
} from './lib/runtime-version-utils.mjs';

// 安装流程复用底层诊断执行器（签名一致：command, args, { cwd, extraEnv, timeoutMs }）。
const runViaShell = runLocalPostDiagnosticCommand;

const LOCAL_POST_LATEST_VERSION_SOURCES = {
  ocio: {
    sourceLabel: 'GitHub Releases',
    apiUrl: 'https://api.github.com/repos/AcademySoftwareFoundation/OpenColorIO/releases/latest',
  },
  oiio: {
    sourceLabel: 'GitHub Releases',
    apiUrl: 'https://api.github.com/repos/AcademySoftwareFoundation/OpenImageIO/releases/latest',
  },
  gmic: {
    sourceLabel: 'gmic.eu',
    pageUrl: 'https://gmic.eu/download.html',
    versionPatterns: [
      /Latest stable version[^0-9]*([0-9]+(?:\.[0-9]+){1,4})/i,
      /G'MIC[^0-9]*([0-9]+(?:\\.[0-9]+){1,4})/i,
    ],
  },
  ytdlp: {
    sourceLabel: 'GitHub Releases',
    apiUrl: 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
  },
  florence2: {
    // Florence-2 没有传统「发布版本号」，这里跟踪 Hugging Face 模型仓库的最新 commit，
    // 同时固定 PyTorch / Transformers 的已知良好版本，确保「一键安装」拿到的是最新稳定组合。
    sourceLabel: 'Hugging Face / PyPI',
    apiUrl: 'https://huggingface.co/api/models/microsoft/Florence-2-large',
    pinnedVersion: 'Florence-2-large · torch 2.9.0(CPU) · transformers 4.51.3 · Python 3.14 兼容',
  },
  aria2: {
    sourceLabel: 'GitHub Releases',
    apiUrl: 'https://api.github.com/repos/aria2/aria2/releases/latest',
  },
  ffmpeg: {
    sourceLabel: 'BtbN FFmpeg-Builds',
    apiUrl: 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest',
  },
};

async function fetchLatestLocalPostRuntimeVersion(key, { force = false } = {}) {
  const source = LOCAL_POST_LATEST_VERSION_SOURCES[key];
  if (!source) {
    return {
      supported: false,
      checkedAt: new Date().toISOString(),
      latestVersion: '',
      releaseUrl: '',
      sourceLabel: '',
      error: '',
    };
  }
  const cached = LOCAL_POST_RELEASE_CACHE.get(key);
  if (!force && cached && Date.now() - cached.cachedAt < LOCAL_POST_RELEASE_TTL_MS) {
    return cached.payload;
  }

  const result = {
    supported: true,
    checkedAt: new Date().toISOString(),
    latestVersion: '',
    releaseUrl: '',
    sourceLabel: String(source.sourceLabel || '').trim(),
    error: '',
  };

  try {
    if (source.apiUrl) {
      const response = await fetch(source.apiUrl, {
        headers: {
          'User-Agent': 'HMDAO Runtime Checker',
          Accept: 'application/vnd.github+json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null);
      result.latestVersion = firstSemverToken(payload?.tag_name || payload?.name || '');
      result.releaseUrl = String(payload?.html_url || source.docsUrl || '').trim();
      if (!result.latestVersion && source.pinnedVersion) {
        // Florence-2 等无语义化版本号的特殊运行时：使用固定已知良好版本组合
        result.latestVersion = String(source.pinnedVersion || '').trim();
      }
      if (!result.latestVersion) {
        throw new Error('latest-version-not-found');
      }
    } else if (source.pageUrl) {
      const response = await fetch(source.pageUrl, {
        headers: {
          'User-Agent': 'HMDAO Runtime Checker',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const matched = source.versionPatterns
        .map((pattern) => text.match(pattern))
        .find((item) => item?.[1]);
      result.latestVersion = matched?.[1] || '';
      result.releaseUrl = source.pageUrl;
      if (!result.latestVersion) {
        throw new Error('latest-version-not-found');
      }
    }
  } catch (error) {
    result.error = trimDiagnosticText(error instanceof Error ? error.message : String(error), 220);
  }

  if (result.error && cached?.payload?.latestVersion) {
    return {
      ...cached.payload,
      checkedAt: new Date().toISOString(),
      error: '',
    };
  }

  LOCAL_POST_RELEASE_CACHE.set(key, {
    cachedAt: Date.now(),
    payload: result,
  });
  return result;
}

async function buildRuntimeUpdateStatus(key, installedVersion = '', options = {}) {
  const latest = await fetchLatestLocalPostRuntimeVersion(key, options);
  const latestVersion = String(latest.latestVersion || '').trim();
  const normalizedInstalled = String(installedVersion || '').trim();
  const updateAvailable = Boolean(latestVersion && normalizedInstalled && compareVersionStrings(normalizedInstalled, latestVersion) < 0);
  return {
    supported: Boolean(latest.supported),
    checkedAt: latest.checkedAt,
    sourceLabel: String(latest.sourceLabel || '').trim(),
    releaseUrl: String(latest.releaseUrl || '').trim(),
    latestVersion,
    installedVersion: normalizedInstalled,
    updateAvailable,
    status: latest.error
      ? 'error'
      : latestVersion
        ? updateAvailable
          ? 'update-available'
          : normalizedInstalled
            ? 'up-to-date'
            : 'latest-known'
        : 'unknown',
    summary: latest.error
      ? `最新版检查失败：${latest.error}`
      : latestVersion
        ? normalizedInstalled
          ? updateAvailable
            ? 'Detected latest version ' + latestVersion + ', current version is ' + normalizedInstalled + '.'
            : 'Current version ' + normalizedInstalled + ' already matches latest version ' + latestVersion + '.'
          : 'Latest version ' + latestVersion + ' is available; compare again after local installation is detected.'
        : '暂未获取到最新版信息',
    error: String(latest.error || '').trim(),
  };
}

async function buildLocalPostDoctorReport({ forceRelease = false } = {}) {
  clearLocalPostRuntimeDetectionCache();
  const checkedAt = new Date().toISOString();
  const resolvedOcioBackend = resolveLocalPostOcioBackend({ ocioExecutionMode: 'auto' });
  const resolvedOiioBackend = resolveLocalPostOiioBackend({ ocioExecutionMode: 'auto' }, 'image', '');
  const resolvedGmicBackend = resolveLocalPostGmicBackend();
  const resolvedAria2Backend = resolveLocalPostAria2Backend();
  const resolvedFfmpegBackend = resolveLocalPostFfmpegBackend();
  const ocioConfigPath = String(resolvedOiioBackend.detectedConfigPath || detectLocalPostOiioConfigPath()).trim();
  // ★ 复用 resolveYtDlpPath：它已包含「托管运行时目录 + 固定路径 + 系统 PATH」的完整回退，
  // 因此用户自己在 PATH 里安装的 yt-dlp 也能被模型下载面板与扩展侧栏识别到（此前 doctor 报告
  // 只用 detectManagedLocalPostYtDlpPath，只查托管目录，导致自装 yt-dlp 永远显示「未安装」）。
  // resolveYtDlpPath 在都找不到时会兜底返回首个固定路径（可能不存在），此处做存在性校验避免误报。
  let ytDlpDetectedPath = String(resolveYtDlpPath() || detectManagedLocalPostYtDlpPath() || '').trim();
  if (ytDlpDetectedPath) {
    // ★2026-09-01 修复：同 resolveYtDlpPath 的 require('fs') 问题。
    //   旧代码 require 未定义 → 抛错 → catch 把【已成功检测到的路径清空】
    //   → doctor 报告恒为 detectedPath:"" / "yt-dlp.exe was not detected"（与事实相反）。
    try { if (!existsSync(ytDlpDetectedPath)) ytDlpDetectedPath = ''; }
    catch (_) { ytDlpDetectedPath = ''; }
  }
  const florence2DetectedPath = String(detectManagedLocalPostFlorence2Path() || '').trim();
  const florence2Python = String(detectManagedLocalPostFlorence2Python() || '').trim();
  const florence2Entry = getManagedRuntimeManifestEntry('florence2') || {};

  const gmicDetectedPath = String(resolvedGmicBackend.detectedPath || '').trim();
  const oiioDetectedPath = String(resolvedOiioBackend.detectedPath || '').trim();
  const ocioRuntimePath = String(detectLocalPostOcioRuntimePath() || resolvedOcioBackend.detectedPath || '').trim();

  const aria2DetectedPath = String(detectManagedLocalPostAria2Path() || '').trim();
  const ffmpegDetectedPath = String(detectManagedLocalPostFfmpegPath() || '').trim();

  const [gmicVersion, oiioVersion, ocioVersion, ytDlpVersion, florence2Version, aria2Version, ffmpegVersion] = await Promise.all([
    gmicDetectedPath
      ? detectInstalledRuntimeVersion(gmicDetectedPath, [{ args: ['version'] }, { args: ['--version'] }, { args: ['-version'] }])
      : Promise.resolve(null),
    oiioDetectedPath
      ? detectInstalledRuntimeVersion(oiioDetectedPath, [{ args: ['--version'] }])
      : Promise.resolve(null),
    ocioRuntimePath
      ? detectOcioRuntimeInstallation(ocioRuntimePath)
      : Promise.resolve(null),
    ytDlpDetectedPath
      ? detectInstalledRuntimeVersion(ytDlpDetectedPath, [{ args: ['--version'] }])
      : Promise.resolve(null),
    florence2DetectedPath && florence2Python
      ? runViaShell(florence2Python, ['-c', 'import torch, transformers; print("ok")'], { cwd: path.dirname(florence2DetectedPath) })
          .then((r) => ({ ok: r.exitCode === 0, version: String(florence2Entry.version || '').trim() }))
          .catch(() => ({ ok: false, version: '' }))
      : Promise.resolve(null),
    aria2DetectedPath
      ? detectInstalledRuntimeVersion(aria2DetectedPath, [{ args: ['--version'] }])
      : Promise.resolve(null),
    ffmpegDetectedPath
      ? detectInstalledRuntimeVersion(ffmpegDetectedPath, [{ args: ['-version'] }])
      : Promise.resolve(null),
  ]);

  const ocioConfigReadable = ocioConfigPath
    ? await fs.access(ocioConfigPath).then(() => true).catch(() => false)
    : false;
  const ocioConfigProbe = ocioConfigReadable && oiioDetectedPath
    ? await runLocalPostDiagnosticCommand(oiioDetectedPath, ['--colorconfig', ocioConfigPath, '--colorconfiginfo'], {
      cwd: path.dirname(oiioDetectedPath),
      extraEnv: { OCIO: ocioConfigPath },
    })
    : null;

  const [gmicUpdate, oiioUpdate, ocioUpdate, ytDlpUpdate, florence2Update] = await Promise.all([
    buildRuntimeUpdateStatus('gmic', gmicVersion?.version || '', { force: forceRelease }),
    buildRuntimeUpdateStatus('oiio', oiioVersion?.version || '', { force: forceRelease }),
    buildRuntimeUpdateStatus('ocio', ocioVersion?.version || '', { force: forceRelease }),
    buildRuntimeUpdateStatus('ytdlp', ytDlpVersion?.version || '', { force: forceRelease }),
    buildRuntimeUpdateStatus('florence2', florence2Version?.version || '', { force: forceRelease }),
  ]);

  return {
    checkedAt,
    runtimes: {
      gmic: {
        runtimeKey: 'gmic',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.gmic.runtimeName,
        status: gmicDetectedPath
          ? gmicVersion?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: gmicDetectedPath
          ? gmicVersion?.ok
            ? 'gmic.exe passed self-check via ' + (Array.isArray(gmicVersion?.commandArgs) ? gmicVersion.commandArgs.join(' ') : '--version') + '.'
            : 'gmic.exe was found, but self-check failed.'
          : 'gmic.exe was not detected.',
        detectedPath: gmicDetectedPath,
        executableVerified: Boolean(gmicVersion?.ok),
        installedVersion: String(gmicVersion?.version || '').trim(),
        checkedCommand: gmicVersion?.commandArgs || [],
        stdout: gmicVersion?.probe?.stdout || '',
        stderr: gmicVersion?.probe?.stderr || '',
        elapsedMs: Number(gmicVersion?.probe?.elapsedMs || 0),
        suggestions: gmicDetectedPath
          ? gmicVersion?.ok
            ? ['如刚升级版本，可点"刷新运行时"让节点重新识别']
            : ['确认 gmic.exe 可在命令行直接执行', '如果是便携版，请把真实 exe 路径写入 HMDAO_POST_GMIC_PATH']
          : ['先安装 G\'MIC CLI，再点"一键自检"', 'Windows 常见路径见运行时卡片'],
        update: gmicUpdate,
      },
      oiio: {
        runtimeKey: 'oiio',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.oiio.runtimeName,
        status: oiioDetectedPath
          ? oiioVersion?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: oiioDetectedPath
          ? oiioVersion?.ok
            ? 'oiiotool.exe passed the --version self-check.'
            : 'oiiotool.exe was found, but self-check failed.'
          : 'oiiotool.exe was not detected.',
        detectedPath: oiioDetectedPath,
        executableVerified: Boolean(oiioVersion?.ok),
        installedVersion: String(oiioVersion?.version || '').trim(),
        checkedCommand: oiioVersion?.commandArgs || [],
        stdout: oiioVersion?.probe?.stdout || '',
        stderr: oiioVersion?.probe?.stderr || '',
        elapsedMs: Number(oiioVersion?.probe?.elapsedMs || 0),
        detectedConfigPath: ocioConfigPath,
        configVerified: Boolean(ocioConfigProbe?.ok),
        configSummary: ocioConfigPath
          ? ocioConfigProbe
            ? ocioConfigProbe.ok
              ? 'The current OCIO config passed deep validation through oiiotool.'
              : 'An OCIO config was detected, but oiiotool validation did not pass.'
            : ocioConfigReadable
              ? 'An OCIO config was detected, but oiiotool could not deep-validate it in the current environment.'
              : 'An OCIO config path was detected, but the file is not readable.'
          : 'No OCIO config was detected.',
        configStdout: ocioConfigProbe?.stdout || '',
        configStderr: ocioConfigProbe?.stderr || '',
        suggestions: oiioDetectedPath
          ? oiioVersion?.ok
            ? ['如需严格图片色彩管理，再确认 HMDAO_POST_OIIO_OCIO_CONFIG 的 OCIO 指向正确配置']
            : ['确认 oiiotool.exe 可在命令行直接执行', '检查安装目录是否缺少依赖 DLL']
          : ['先安装 OpenImageIO oiiotool，再点"一键自检"', '安装完成后可设置 HMDAO_POST_OIIO_PATH 指向 oiiotool.exe'],
        update: oiioUpdate,
      },
      ocio: {
        runtimeKey: 'ocio',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.ocio.runtimeName,
        status: ocioRuntimePath
          ? ocioVersion?.ok
            ? ocioConfigPath
              ? ocioConfigProbe
                ? ocioConfigProbe.ok
                  ? 'ok'
                  : 'warn'
                : ocioConfigReadable
                  ? 'warn'
                  : 'error'
              : 'warn'
            : 'error'
          : 'error',
        summary: ocioRuntimePath
          ? ocioVersion?.ok
            ? ocioConfigPath
              ? ocioConfigProbe
                ? ocioConfigProbe.ok
                  ? 'OpenColorIO Runtime and the current config passed real-chain validation.'
                  : 'OpenColorIO Runtime is installed, but the current config still needs validation.'
                : ocioConfigReadable
                  ? 'OpenColorIO Runtime is installed and waiting for OIIO to deep-validate the current config.'
                  : 'OpenColorIO Runtime is installed, but the current config file is not readable.'
              : 'OpenColorIO Runtime is installed, but no usable config was detected.'
            : 'OpenColorIO Runtime was detected, but self-check failed.'
          : 'OpenColorIO Runtime was not detected.',
        detectedPath: ocioRuntimePath,
        executableVerified: Boolean(ocioVersion?.ok),
        installedVersion: String(ocioVersion?.version || '').trim(),
        runtimeConfigured: Boolean(resolvedOcioBackend.configured),
        commandConfigured: Boolean(resolvedOcioBackend.commandLine),
        detectedConfigPath: ocioConfigPath,
        configVerified: Boolean(ocioConfigProbe?.ok),
        configReadable: ocioConfigReadable,
        checkedCommand: ocioConfigProbe
          ? ['oiiotool', '--colorconfig', ocioConfigPath, '--colorconfiginfo']
          : ocioVersion?.commandArgs || [],
        stdout: ocioConfigProbe?.stdout || ocioVersion?.probe?.stdout || '',
        stderr: ocioConfigProbe?.stderr || ocioVersion?.probe?.stderr || '',
        elapsedMs: Number(ocioConfigProbe?.elapsedMs || ocioVersion?.probe?.elapsedMs || 0),
        suggestions: ocioRuntimePath
          ? ocioVersion?.ok
            ? ocioConfigPath
              ? ocioConfigProbe?.ok
                ? ['如更改 config 文件，点"刷新运行时"后再重新自检']
                : ['当前 OpenColorIO Runtime 已安装。若需深度校验，请继续安装 OpenImageIO oiiotool', '确认 OCIO config 指向官方或可执行的配置文件']
              : ['先安装或同步官方 ACES config，再点"一键自检"']
            : ['确认 ocioconvert.exe 可在命令行直接执行', '检查 OpenColorIO 安装目录是否完整']
          : ['先安装 OpenColorIO Runtime，再点"一键自检"'],
        update: ocioUpdate,
      },
      ytdlp: {
        runtimeKey: 'ytdlp',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.ytdlp.runtimeName,
        status: ytDlpDetectedPath
          ? ytDlpVersion?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: ytDlpDetectedPath
          ? ytDlpVersion?.ok
            ? 'yt-dlp.exe passed the --version self-check.'
            : 'yt-dlp.exe was found, but self-check failed.'
          : 'yt-dlp.exe was not detected.',
        detectedPath: ytDlpDetectedPath,
        executableVerified: Boolean(ytDlpVersion?.ok),
        installedVersion: String(ytDlpVersion?.version || '').trim(),
        checkedCommand: ytDlpVersion?.commandArgs || [],
        stdout: ytDlpVersion?.probe?.stdout || '',
        stderr: ytDlpVersion?.probe?.stderr || '',
        elapsedMs: Number(ytDlpVersion?.probe?.elapsedMs || 0),
        suggestions: ytDlpDetectedPath
          ? ytDlpVersion?.ok
            ? ['扩展采集 YouTube 直链已可用，如刚升级版本可点"刷新运行时"']
            : ['确认 yt-dlp.exe 可在命令行直接执行', '如在受限网络，可手动下载后写入 HMDAO_YT_DLP_PATH']
          : ['在「模型下载」面板的运行时卡片中点「一键安装 yt-dlp」', '或从 GitHub 手动下载 yt-dlp.exe 并放到本地运行时目录'],
        update: ytDlpUpdate,
      },
      florence2: {
        runtimeKey: 'florence2',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.florence2.runtimeName,
        status: florence2DetectedPath
          ? florence2Version?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: florence2DetectedPath
          ? florence2Version?.ok
            ? 'Florence-2 视觉分析运行时自检通过，图片/视频分析将输出真实模型理解。'
            : 'Florence-2 推理脚本已找到，但 Python 依赖/模型校验失败。'
          : '未检测到 Florence-2 运行时，图片/视频分析将使用弱占位描述（建议安装）。',
        detectedPath: florence2DetectedPath,
        executableVerified: Boolean(florence2Version?.ok),
        installedVersion: String(florence2Version?.version || florence2Entry.version || '').trim(),
        stdout: florence2Version?.stdout || '',
        stderr: florence2Version?.stderr || '',
        modelDir: String(florence2Entry.hfHome || '').trim(),
        suggestions: florence2DetectedPath
          ? florence2Version?.ok
            ? ['可在资产库/智能生成的视觉分析中选择 Florence-2 作为引擎']
            : ['确认虚拟环境依赖完整（torch/transformers）', '确认模型目录已下载 Florence-2-large 权重']
          : ['在「模型下载」面板点「一键安装 Florence-2（本地免费）」', '需先安装 Python 3.10+ 并加入 PATH'],
        update: florence2Update,
      },
      aria2: {
        runtimeKey: 'aria2',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.aria2.runtimeName,
        status: aria2DetectedPath
          ? aria2Version?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: aria2DetectedPath
          ? aria2Version?.ok
            ? 'aria2c.exe passed the --version self-check.'
            : 'aria2c.exe was found, but self-check failed.'
          : 'aria2c.exe was not detected.',
        detectedPath: aria2DetectedPath,
        executableVerified: Boolean(aria2Version?.ok),
        installedVersion: String(aria2Version?.version || '').trim(),
        checkedCommand: aria2Version?.commandArgs || [],
        stdout: aria2Version?.probe?.stdout || '',
        stderr: aria2Version?.probe?.stderr || '',
        elapsedMs: Number(aria2Version?.probe?.elapsedMs || 0),
        runtimeConfigured: Boolean(resolvedAria2Backend.configured),
        suggestions: aria2DetectedPath
          ? aria2Version?.ok
            ? ['扩展采集的网盘直链可用 Aria2 多线程下载', '如刚升级版本可点"刷新运行时"']
            : ['确认 aria2c.exe 可在命令行直接执行', '如在受限网络，可手动下载后写入 HMDAO_ARIA2_PATH']
          : ['在「模型下载」面板的运行时卡片中点「一键安装 Aria2」', '或从 GitHub 手动下载 aria2c 并放到本地运行时目录'],
      },
      ffmpeg: {
        runtimeKey: 'ffmpeg',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.ffmpeg.runtimeName,
        status: ffmpegDetectedPath
          ? ffmpegVersion?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: ffmpegDetectedPath
          ? ffmpegVersion?.ok
            ? 'ffmpeg.exe passed the -version self-check.'
            : 'ffmpeg.exe was found, but self-check failed.'
          : 'ffmpeg.exe was not detected.',
        detectedPath: ffmpegDetectedPath,
        executableVerified: Boolean(ffmpegVersion?.ok),
        installedVersion: String(ffmpegVersion?.version || '').trim(),
        checkedCommand: ffmpegVersion?.commandArgs || [],
        stdout: ffmpegVersion?.probe?.stdout || '',
        stderr: ffmpegVersion?.probe?.stderr || '',
        elapsedMs: Number(ffmpegVersion?.probe?.elapsedMs || 0),
        runtimeConfigured: Boolean(resolvedFfmpegBackend.configured),
        suggestions: ffmpegDetectedPath
          ? ffmpegVersion?.ok
            ? ['yt-dlp 现在可完整合并音视频流', '如刚升级版本可点"刷新运行时"']
            : ['确认 ffmpeg.exe 可在命令行直接执行', '如手动安装可写入 HMDAO_FFMPEG_PATH']
          : ['在「模型下载」面板的运行时卡片中点「一键安装 FFmpeg」', '或从 FFmpeg-Builds 手动下载并放到本地运行时目录'],
      },
    },
  };
}

async function runConfiguredPostUpscaleBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    requestId: payload.requestId,
    route: resolvedBackend.resolvedRoute,
    mediaKind: payload.mediaKind,
    inputPath: payload.inputPath,
    outputPath: payload.outputPath,
    scale: payload.scale,
    denoise: payload.denoise,
    sharpen: payload.sharpen,
    tileSize: payload.tileSize,
    seamFix: payload.seamFix,
    temporalStability: payload.temporalStability,
    gpuTier: payload.gpuTier,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-upscale-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error(`local-post-upscale-empty:${resolvedBackend.resolvedRoute}`);
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
  };
}

async function runConfiguredDepthBackend(commandLine, payload) {
  if (!commandLine) return null;
  const { parsed } = await runJsonWrapperCommand(commandLine, payload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-depth-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-depth-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || 'Depth Anything V2'),
  };
}

async function runConfiguredPostOcioBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    ...payload,
    runtimePath: resolvedBackend.detectedPath,
    defaultOcioConfigPath: resolvedBackend.detectedConfigPath,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-ocio-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-ocio-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((item) => String(item)) : [],
  };
}

async function runConfiguredPostOiioBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    ...payload,
    runtimePath: resolvedBackend.detectedPath,
    defaultOcioConfigPath: resolvedBackend.detectedConfigPath,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-oiio-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-oiio-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((item) => String(item)) : [],
  };
}

async function runConfiguredPostGmicBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    ...payload,
    runtimePath: resolvedBackend.detectedPath,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-gmic-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-gmic-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((item) => String(item)) : [],
  };
}

// P1-11：以下 8 个函数已抽取至 lib/post-filter-builders.mjs。
import {
  buildPostBloomFilterComplex,
  buildPostColorFilter,
  buildPostDofFilterComplex,
  buildPostGrainFilter,
  buildPostUpscaleFilter,
  finalizePostVideo,
  runPostStep,
  writePostAssetInput,
} from './lib/post-filter-builders.mjs';

async function processLocalPostRequest(payload) {
  const mediaKind = payload?.mediaKind === 'video' ? 'video' : 'image';
  const uploadedInputPath = String(payload?.inputPath || '').trim();
  const inputBase64 = String(payload?.inputBase64 || '').trim();
  const sourceUrl = String(payload?.sourceUrl || '').trim();
  if (!uploadedInputPath && !inputBase64 && !/^https?:\/\//i.test(sourceUrl)) {
    throw new Error('local-post-input-missing');
  }

  await fs.mkdir(LOCAL_POST_EDIT_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const inputExt = extensionFromMimeType(payload?.inputMimeType || (mediaKind === 'video' ? 'video/mp4' : 'image/png'));
  const inputPath = uploadedInputPath || path.join(LOCAL_POST_EDIT_DIR, `${requestId}-input.${inputExt}`);
  const finalPath = path.join(LOCAL_POST_EDIT_DIR, `${requestId}-final.${mediaKind === 'video' ? 'webm' : 'png'}`);
  const tempPaths = [];
  const assetPaths = [];
  const warnings = [];
  const processingMeta = {
    appliedStages: [],
  };
  let persistedResultPath = '';

  try {
    if (uploadedInputPath) {
      // File already landed on disk during multipart upload.
    } else if (inputBase64) {
      await fs.writeFile(inputPath, Buffer.from(inputBase64, 'base64'));
    } else {
      const remote = await downloadRemoteMediaBuffer(sourceUrl);
      await fs.writeFile(inputPath, remote.bytes);
    }

    const assetsByKey = new Map();
    for (const asset of Array.isArray(payload?.assets) ? payload.assets : []) {
      const filePath = await writePostAssetInput(LOCAL_POST_EDIT_DIR, requestId, asset);
      if (filePath) {
        assetsByKey.set(String(asset.key), filePath);
        assetPaths.push(filePath);
      }
    }

    let currentPath = inputPath;
    let currentMeta = mediaKind === 'video' ? await probeVideoFile(inputPath) : await probeImageFile(inputPath);
    const effects = payload?.effects && typeof payload.effects === 'object' ? payload.effects : {};
    let stepIndex = 0;

    const color = effects.color && typeof effects.color === 'object' ? effects.color : null;
    if (color?.enabled) {
      const colorLutPath = assetsByKey.get('color-lut') || '';
      let ocioConfigPath = assetsByKey.get('color-ocio-config') || '';
      const resolvedOcioBackend = resolveLocalPostOcioBackend(color);
      let ocioConfigInspection = null;
      if (color.lutAssetUrl && !colorLutPath) {
        warnings.push('已选择 LUT，但当前没有可读取的 LUT 文件，已跳过 LUT 应用');
      } else if (colorLutPath && !isSupportedLutFile(colorLutPath)) {
        warnings.push('当前仅支持 .cube / .3dl LUT 文件，已跳过不支持的 LUT');
      }
      if (String(color.ocioConfig || '').trim() === 'custom-file') {
        if (!ocioConfigPath) {
          if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
            throw new Error('当前已切换到"仅 Wrapper + 自定义 .ocio"，但没有上传可读取的 OCIO 配置文件');
          }
          warnings.push('已切换到自定义 OCIO Config，但当前没有可读取的 config 文件，已回退到默认 OCIO 策略');
        } else if (!isSupportedOcioConfigFile(ocioConfigPath)) {
          if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
            throw new Error('当前自定义 OCIO Config 文件格式不在支持范围内，且执行模式为 Wrapper');
          }
          warnings.push('当前自定义 OCIO Config 文件扩展名不在支持范围内，已回退到默认 OCIO 策略');
          ocioConfigPath = '';
        } else {
          ocioConfigInspection = await inspectOcioConfigFile(ocioConfigPath);
          if (!ocioConfigInspection.structurallyValid) {
            if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
              throw new Error(`当前自定义 OCIO Config 不可执行{ocioConfigInspection.message}`);
            }
            warnings.push(`当前自定义 OCIO Config 结构不可执行，已回退到默认 OCIO 策略{ocioConfigInspection.message}`);
            ocioConfigPath = '';
          } else if (!ocioConfigInspection.executable) {
            if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
              throw new Error(`当前自定义 OCIO Config 缺少完整执行路由{ocioConfigInspection.message}`);
            }
            warnings.push(`当前自定义 OCIO Config 缺少完整执行路由{ocioConfigInspection.message}`);
          }
        }
      } else if (ocioConfigPath && !isSupportedOcioConfigFile(ocioConfigPath)) {
        warnings.push('检测到附带的 OCIO Config 文件扩展名不在支持范围，当前已忽略');
        ocioConfigPath = '';
      }
      const resolvedOiioBackend = resolveLocalPostOiioBackend(color, mediaKind, ocioConfigPath);
      if (String(color.ocioExecutionMode || '').trim() === 'fallback-only' && String(color.ocioConfig || '').trim() === 'custom-file' && ocioConfigPath) {
        warnings.push('当前执行模式为仅本地回退，自定义 .ocio 不会调用外部 Wrapper，只会保留近似调色风格');
      }
      if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only' && !resolvedOcioBackend.configured && !resolvedOiioBackend.configured) {
        throw new Error('当前 OCIO 执行模式为仅 Wrapper，但后端没有检测到可用的 OIIO / OCIO Runtime');
      }
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      let oiioApplied = false;
      let oiioWrapperResult = null;
      let ocioWrapperApplied = false;
      let ocioWrapperResult = null;
      if (resolvedOiioBackend.wrapperAllowed && resolvedOiioBackend.configured) {
        try {
          oiioWrapperResult = await runConfiguredPostOiioBackend(resolvedOiioBackend, {
            requestId,
            mediaKind,
            route: 'oiio',
            inputPath: currentPath,
            outputPath: nextPath,
            lutPath: colorLutPath,
            ocioConfigPath,
            colorConfig: color,
          });
          oiioApplied = true;
          warnings.push(...(oiioWrapperResult?.warnings || []));
        } catch (error) {
          if (!resolvedOiioBackend.fallbackAllowed && !resolvedOcioBackend.configured) {
            throw error;
          }
          warnings.push('OIIO 严格图片调色执行失败，当前已继续尝试 OCIO wrapper / 本地调色链路');
        }
      } else if (resolvedOiioBackend.wrapperAllowed && resolvedOiioBackend.runtimeConfigured && !resolvedOiioBackend.configured) {
        warnings.push('已检测到 oiiotool，但缺少可用的 OCIO Config，当前先继续尝试 OCIO wrapper / 本地调色链路');
      }
      if (!oiioApplied && resolvedOcioBackend.wrapperAllowed && resolvedOcioBackend.configured) {
        try {
          ocioWrapperResult = await runConfiguredPostOcioBackend(resolvedOcioBackend, {
            requestId,
            mediaKind,
            route: 'ocio',
            inputPath: currentPath,
            outputPath: nextPath,
            lutPath: colorLutPath,
            ocioConfigPath,
            colorConfig: color,
          });
          ocioWrapperApplied = true;
          warnings.push(...(ocioWrapperResult?.warnings || []));
        } catch (error) {
          if (!resolvedOcioBackend.fallbackAllowed) {
            throw error;
          }
          warnings.push('OCIO wrapper 执行失败，当前已自动回退到本地调色链路');
        }
      } else if (!oiioApplied && resolvedOcioBackend.wrapperAllowed && !resolvedOcioBackend.configured && !resolvedOcioBackend.fallbackAllowed) {
        throw new Error('OCIO wrapper 未配置，且当前执行模式禁止回退');
      } else if (!oiioApplied && resolvedOcioBackend.wrapperAllowed && !resolvedOcioBackend.configured) {
        warnings.push('OCIO wrapper 未配置，当前先走本地调色链路');
      }
      if (!oiioApplied && !ocioWrapperApplied) {
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          filter: buildPostColorFilter(color, colorLutPath),
          stage: 'post-color',
        });
      }
      processingMeta.ocioBackendLabel = oiioApplied
        ? String(oiioWrapperResult?.engine || resolvedOiioBackend.label)
        : ocioWrapperApplied
          ? String(ocioWrapperResult?.engine || resolvedOcioBackend.label)
        : 'ffmpeg-post-fallback';
      processingMeta.ocioWrapperConfigured = Boolean(resolvedOcioBackend.configured || resolvedOiioBackend.configured);
      processingMeta.ocioWrapperApplied = Boolean(oiioApplied || ocioWrapperApplied);
      processingMeta.oiioBackendLabel = oiioApplied ? String(oiioWrapperResult?.engine || resolvedOiioBackend.label) : '';
      processingMeta.oiioWrapperConfigured = Boolean(resolvedOiioBackend.runtimeConfigured);
      processingMeta.oiioWrapperApplied = oiioApplied;
      processingMeta.oiioDetectedPath = resolvedOiioBackend.detectedPath || '';
      processingMeta.oiioDetectedConfigPath = resolvedOiioBackend.detectedConfigPath || '';
      processingMeta.oiioWrapperMeta = oiioWrapperResult?.meta || {};
      processingMeta.ocioConfigMode = String(color.ocioConfig || 'builtin');
      processingMeta.ocioExecutionMode = String(color.ocioExecutionMode || 'auto');
      processingMeta.ocioConfigPath = ocioConfigPath || '';
      processingMeta.ocioConfigName = ocioConfigPath ? path.basename(ocioConfigPath) : '';
      processingMeta.ocioConfigFormat = ocioConfigInspection?.formatLabel || '';
      processingMeta.ocioConfigProfileVersion = ocioConfigInspection?.profileVersion || '';
      processingMeta.ocioConfigDetectedSections = ocioConfigInspection?.detectedSections || [];
      processingMeta.ocioConfigStructurallyValid = Boolean(ocioConfigInspection?.structurallyValid);
      processingMeta.ocioConfigExecutable = Boolean(ocioConfigInspection?.executable);
      processingMeta.ocioConfigValidationMessage = ocioConfigInspection?.message || '';
      processingMeta.ocioWrapperMeta = ocioWrapperResult?.meta || {};
      processingMeta.appliedStages.push({
        id: 'color',
        route: oiioApplied ? 'oiio-wrapper' : ocioWrapperApplied ? 'ocio-wrapper' : 'ffmpeg-color-fallback',
        engine: oiioApplied
          ? String(oiioWrapperResult?.engine || resolvedOiioBackend.label)
          : ocioWrapperApplied
            ? String(ocioWrapperResult?.engine || resolvedOcioBackend.label)
            : 'ffmpeg-post-stack',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    const upscale = effects.upscale && typeof effects.upscale === 'object' ? effects.upscale : null;
    if (upscale?.enabled) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      const resolvedBackend = resolveLocalPostUpscaleBackend(upscale, mediaKind);
      let upscaleWrapperResult = null;
      let upscaleFallbackReason = '';
      let wrapperApplied = false;
      if (resolvedBackend.wrapperAllowed && resolvedBackend.configured) {
        try {
          upscaleWrapperResult = await runConfiguredPostUpscaleBackend(resolvedBackend, {
            requestId,
            mediaKind,
            inputPath: currentPath,
            outputPath: nextPath,
            scale: clampNumber(upscale.scale, 1, 8, 2),
            denoise: clampNumber(upscale.denoise, 0, 1, 0.18),
            sharpen: clampNumber(upscale.sharpen, 0, 1, 0.34),
            tileSize: clampNumber(upscale.tileSize, 256, 2048, 768),
            seamFix: Boolean(upscale.seamFix),
            temporalStability: clampNumber(upscale.temporalStability, 0, 1, 0.65),
            gpuTier: String(upscale.gpuTier || '8g-safe').trim(),
          });
          wrapperApplied = true;
        } catch (error) {
          upscaleFallbackReason = error instanceof Error ? error.message : 'upscale-wrapper-failed';
          if (!resolvedBackend.fallbackAllowed) {
            throw error;
          }
          warnings.push(resolvedBackend.label + ' wrapper failed, automatically fell back to the local FFmpeg enhancement path.');
        }
      } else if (resolvedBackend.wrapperAllowed && !resolvedBackend.configured && !resolvedBackend.fallbackAllowed) {
        throw new Error(resolvedBackend.label + ' wrapper is not configured, and fallback is disabled in the current execution mode.');
      } else if (resolvedBackend.wrapperAllowed && !resolvedBackend.configured) {
        upscaleFallbackReason = 'wrapper-not-configured';
        warnings.push(resolvedBackend.label + ' wrapper is not configured, so the local FFmpeg enhancement path is being used first.');
      }
      if (!wrapperApplied) {
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          filter: buildPostUpscaleFilter(upscale, currentMeta, mediaKind),
          stage: 'post-upscale',
        });
      }
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
      processingMeta.upscaleBackendLabel = wrapperApplied
        ? String(upscaleWrapperResult?.engine || resolvedBackend.label)
        : 'ffmpeg-post-stack';
      processingMeta.upscaleWrapperConfigured = Boolean(resolvedBackend.configured);
      processingMeta.upscaleWrapperApplied = wrapperApplied;
      processingMeta.upscaleResolvedRoute = String(resolvedBackend.resolvedRoute || '');
      processingMeta.upscaleExecutionMode = String(upscale.executionMode || 'auto');
      processingMeta.upscaleRoutePolicy = String(upscale.routePolicy || 'auto');
      processingMeta.upscaleModel = String(upscale.model || 'realesrgan-balanced');
      processingMeta.upscaleScale = clampNumber(upscale.scale, 1, 8, 2);
      processingMeta.upscaleTileSize = clampNumber(upscale.tileSize, 256, 2048, 768);
      processingMeta.upscaleGpuTier = String(upscale.gpuTier || '8g-safe').trim();
      processingMeta.upscaleFallbackReason = upscaleFallbackReason;
      processingMeta.upscaleWrapperMeta = upscaleWrapperResult?.meta || {};
      processingMeta.appliedStages.push({
        id: 'upscale',
        route: wrapperApplied ? `${resolvedBackend.resolvedRoute}-wrapper` : 'ffmpeg-upscale-fallback',
        engine: wrapperApplied ? String(upscaleWrapperResult?.engine || resolvedBackend.label) : 'ffmpeg-post-stack',
      });
    }

    const dof = effects.dof && typeof effects.dof === 'object' ? effects.dof : null;
    if (dof?.enabled) {
      let dofDepthMaskPath = assetsByKey.get('dof-depth-mask') || '';
      if (!dofDepthMaskPath && dof.engine === 'depth-anything-v2-small') {
        const { commandLine: depthCommand } = resolveLocalPostWrapperCommand({
          envCommand: 'HMDAO_POST_DEPTH_ANYTHING_COMMAND',
          envPath: 'HMDAO_POST_DEPTH_ANYTHING_PATH',
          wrapperKey: 'depth',
        });
        if (depthCommand) {
          const generatedDepthPath = path.join(LOCAL_POST_EDIT_DIR, `${requestId}-depth-mask.png`);
          try {
            const depthResult = await runConfiguredDepthBackend(depthCommand, {
              requestId,
              inputPath: currentPath,
              outputPath: generatedDepthPath,
              mediaKind,
              strength: clampNumber(dof.autoDepthStrength, 0, 1, 0.68),
            });
            dofDepthMaskPath = depthResult?.outputPath || generatedDepthPath;
            assetPaths.push(generatedDepthPath);
          } catch (error) {
            warnings.push('自动深度估计执行失败，当前回退到手动焦区链路');
          }
        } else {
          warnings.push('Depth Anything 本地 wrapper 未配置，当前回退到手动焦区链路');
        }
      }
      if (dof.bokehAssetUrl && !assetsByKey.get('dof-bokeh')) {
        warnings.push('已选择自定义 Bokeh，但当前没有可读取的光圈贴图，已回退到基础散景形状');
      } else if (assetsByKey.get('dof-bokeh') && !isSupportedBokehFile(assetsByKey.get('dof-bokeh'))) {
        warnings.push('当前仅支持 PNG / WebP Bokeh 贴图，已回退到基础散景形状');
      }
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      const extraInputs = dofDepthMaskPath ? [dofDepthMaskPath] : [];
      await runPostStep({
        mediaKind,
        inputPath: currentPath,
        outputPath: nextPath,
        extraInputs,
        filterComplex: buildPostDofFilterComplex(dof, currentMeta, dofDepthMaskPath),
        stage: 'post-dof',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    const bloom = effects.bloom && typeof effects.bloom === 'object' ? effects.bloom : null;
    const grain = effects.grain && typeof effects.grain === 'object' ? effects.grain : null;
    const resolvedGmicBackend = resolveLocalPostGmicBackend();
    const gmicDetailEnabled = mediaKind === 'image' && upscale?.enabled && (
      clampNumber(upscale.denoise, 0, 1, 0.18) > 0.01
      || clampNumber(upscale.sharpen, 0, 1, 0.34) > 0.01
      || String(upscale.mode || 'balanced').trim() === 'detail'
      || String(upscale.model || '').trim() === 'supir-detail'
    );
    const shouldTryGmic = mediaKind === 'image' && resolvedGmicBackend.configured && (
      Boolean(bloom?.enabled)
      || Boolean(grain?.enabled)
      || gmicDetailEnabled
    );
    let gmicHandledBloom = false;
    let gmicHandledGrain = false;
    if ((bloom?.enabled || grain?.enabled) && mediaKind !== 'image') {
      warnings.push('G\'MIC 当前只接入图片后期链路；视频上的 Bloom / Grain 继续走 FFmpeg 回退');
    }
    if (shouldTryGmic) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      let gmicFallbackReason = '';
      let gmicResult = null;
      try {
        gmicResult = await runConfiguredPostGmicBackend(resolvedGmicBackend, {
          requestId,
          mediaKind,
          route: 'gmic',
          inputPath: currentPath,
          outputPath: nextPath,
          bloomConfig: bloom?.enabled ? bloom : { enabled: false },
          grainConfig: grain?.enabled ? grain : { enabled: false },
          detailConfig: {
            enabled: gmicDetailEnabled,
            denoise: clampNumber(upscale?.denoise, 0, 1, 0.18),
            sharpen: clampNumber(upscale?.sharpen, 0, 1, 0.34),
            mode: String(upscale?.mode || 'balanced').trim(),
          },
        });
        warnings.push(...(gmicResult?.warnings || []));
        gmicHandledBloom = Boolean(bloom?.enabled);
        gmicHandledGrain = Boolean(grain?.enabled);
        tempPaths.push(nextPath);
        currentPath = nextPath;
        currentMeta = await probeImageFile(currentPath);
      } catch (error) {
        gmicFallbackReason = error instanceof Error ? error.message : 'gmic-wrapper-failed';
        warnings.push('G\'MIC 真实处理执行失败，当前已回退到 FFmpeg Bloom / Grain 链路');
      }
      processingMeta.gmicBackendLabel = gmicResult
        ? String(gmicResult.engine || resolvedGmicBackend.label)
        : 'ffmpeg-post-fallback';
      processingMeta.gmicWrapperConfigured = Boolean(resolvedGmicBackend.configured);
      processingMeta.gmicWrapperApplied = Boolean(gmicResult);
      processingMeta.gmicFallbackReason = gmicFallbackReason;
      processingMeta.gmicDetectedPath = resolvedGmicBackend.detectedPath || '';
      processingMeta.gmicStagesApplied = Array.isArray(gmicResult?.meta?.stagesApplied)
        ? gmicResult.meta.stagesApplied
        : [];
      processingMeta.gmicWrapperMeta = gmicResult?.meta || {};
      if (gmicResult) {
        processingMeta.appliedStages.push({
          id: 'gmic',
          route: 'gmic-wrapper',
          engine: String(gmicResult.engine || resolvedGmicBackend.label),
        });
      }
    } else {
      processingMeta.gmicBackendLabel = resolvedGmicBackend.configured ? resolvedGmicBackend.label : 'ffmpeg-post-fallback';
      processingMeta.gmicWrapperConfigured = Boolean(resolvedGmicBackend.configured);
      processingMeta.gmicWrapperApplied = false;
      processingMeta.gmicFallbackReason = resolvedGmicBackend.configured ? '' : 'wrapper-not-configured';
      processingMeta.gmicDetectedPath = resolvedGmicBackend.detectedPath || '';
      processingMeta.gmicStagesApplied = [];
      processingMeta.gmicWrapperMeta = {};
    }

    if (bloom?.enabled && !gmicHandledBloom) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      await runPostStep({
        mediaKind,
        inputPath: currentPath,
        outputPath: nextPath,
        filterComplex: buildPostBloomFilterComplex(bloom),
        stage: 'post-bloom',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    if (grain?.enabled && !gmicHandledGrain) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      await runPostStep({
        mediaKind,
        inputPath: currentPath,
        outputPath: nextPath,
        filter: buildPostGrainFilter(grain, mediaKind),
        stage: 'post-grain',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    const matting = effects.matting && typeof effects.matting === 'object' ? effects.matting : null;
    if (matting?.enabled) {
      const maskPath = assetsByKey.get('matting-mask');
      const backgroundPath = assetsByKey.get('matting-background');
      if (!maskPath) {
        warnings.push('抠像已启用，但当前没有可执行的蒙版素材，已跳过');
      } else {
        const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
        const bgPath = backgroundPath || null;
        const baseInputs = bgPath ? [bgPath, maskPath] : [maskPath];
        const fillColor = 'black';
        const baseGraph = bgPath
          ? [
              `[1:v]scale=${currentMeta.width}:${currentMeta.height}[bg]`,
              `[2:v]format=gray,scale=${currentMeta.width}:${currentMeta.height}[mask]`,
              `[bg][0:v][mask]maskedmerge[vout]`,
            ]
          : [
              `color=c=${fillColor}:s=${currentMeta.width}x${currentMeta.height}[bg]`,
              `[1:v]format=gray,scale=${currentMeta.width}:${currentMeta.height}[mask]`,
              `[bg][0:v][mask]maskedmerge[vout]`,
            ];
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          extraInputs: baseInputs,
          filterComplex: baseGraph.join(';'),
          stage: 'post-matting',
        });
        tempPaths.push(nextPath);
        currentPath = nextPath;
        currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
        if (matting.engine !== 'upload-mask') {
          warnings.push('Matting is currently using the uploaded-mask path first; the ' + String(matting.engine) + ' wrapper entry is reserved but not mounted locally yet.');
        }
      }
    }

    const tracking = effects.tracking && typeof effects.tracking === 'object' ? effects.tracking : null;
    if (tracking?.enabled && Array.isArray(tracking.tracks) && tracking.tracks.length > 0) {
      const usableTracks = tracking.tracks
        .map((track) => ({ track, path: assetsByKey.get(`tracking-${track.id}`) }))
        .filter((item) => item.path);
      if (!usableTracks.length) {
        warnings.push('运动跟踪已启用，但当前没有可叠加的素材，已跳过');
      } else {
        const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
        const filterLines = ['[0:v]setpts=PTS-STARTPTS[base0]'];
        const extraInputs = [];
        let inputIndex = 1;
        usableTracks.forEach((item, index) => {
          extraInputs.push(item.path);
          const scale = clampNumber(item.track.scale, 0.1, 4, 1);
          const rotation = clampNumber(item.track.rotation, -180, 180, 0);
          const opacity = clampNumber(item.track.opacity, 0, 1, 1);
          filterLines.push(
            `[${inputIndex}:v]scale=iw*${scale.toFixed(3)}:ih*${scale.toFixed(3)},rotate=${rotation.toFixed(4)}*PI/180:c=none:ow=rotw(${rotation.toFixed(4)}*PI/180):oh=roth(${rotation.toFixed(4)}*PI/180),format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[ov${index}]`,
          );
          const overlayX = `(W-w)*${(clampNumber(item.track.x, 0, 100, 50) / 100).toFixed(4)}`;
          const overlayY = `(H-h)*${(clampNumber(item.track.y, 0, 100, 50) / 100).toFixed(4)}`;
          const enable = mediaKind === 'video'
            ? `:enable='between(t,${clampNumber(item.track.startTime, 0, 9999, 0).toFixed(3)},${clampNumber(item.track.endTime, 0, 9999, Math.max(item.track.startTime || 0, 5)).toFixed(3)})'`
            : '';
          filterLines.push(`[base${index}][ov${index}]overlay=x=${overlayX}:y=${overlayY}:format=auto${enable}[base${index + 1}]`);
          inputIndex += 1;
          if (item.track.tracker === 'cotracker3-wrapper') {
            warnings.push('Tracking lane ' + (item.track.label || item.track.id) + ' is currently using manual overlay first; the CoTracker3 wrapper entry is reserved.');
          }
        });
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          extraInputs,
          filterComplex: filterLines.join(';'),
          map: `[base${usableTracks.length}]`,
          stage: 'post-tracking',
        });
        tempPaths.push(nextPath);
        currentPath = nextPath;
        currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
      }
    }

    if (mediaKind === 'video') {
      await finalizePostVideo(currentPath, inputPath, finalPath);
    } else {
      await fs.copyFile(currentPath, finalPath);
    }

    const outputMeta = mediaKind === 'video' ? await probeVideoFile(finalPath) : await probeImageFile(finalPath);
    const persisted = await persistLocalPostResultFile(finalPath, requestId, mediaKind);
    persistedResultPath = persisted.persistedPath;
    const outputStat = await fs.stat(persistedResultPath);
    return {
      format: mediaKind === 'video' ? 'webm' : 'png',
      mimeType: mediaKind === 'video' ? 'video/webm' : 'image/png',
      outputAssetId: persisted.assetId,
      outputUrl: persisted.outputUrl,
      size: Number(outputStat.size || 0),
      width: outputMeta.width,
      height: outputMeta.height,
      duration: outputMeta.duration,
      processingEngine: Array.isArray(processingMeta.appliedStages) && processingMeta.appliedStages.length > 0
        ? processingMeta.appliedStages.map((item) => String(item.engine || item.route || 'post-stage')).join(' + ')
        : 'ffmpeg-post-stack',
      warnings,
      processingMeta,
    };
  } finally {
    const cleanupPaths = [inputPath, finalPath, ...tempPaths, ...assetPaths]
      .filter((cleanupPath) => cleanupPath && cleanupPath !== persistedResultPath);
    for (const cleanupPath of cleanupPaths) {
      await fs.rm(cleanupPath, { force: true }).catch(() => {});
    }
  }
}

async function processLocalVideoEditRequest(payload) {
  const operation = String(payload?.operation || '').trim();
  if (!['crop', 'clip', 'hd', 'parse', 'removeSubtitle', 'audioSplit', 'audioMix'].includes(operation)) {
    throw new Error(`unsupported-local-video-operation:${operation || 'unknown'}`);
  }

  const inputBase64 = String(payload?.inputBase64 || '').trim();
  const sourceUrl = String(payload?.sourceUrl || '').trim();
  if (!inputBase64 && !/^https?:\/\//i.test(sourceUrl)) {
    throw new Error('local-video-input-missing');
  }

  await fs.mkdir(LOCAL_VIDEO_EDIT_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const inputExt = extensionFromMimeType(payload?.inputMimeType || 'video/mp4');
  const inputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-input.${inputExt}`);
  const outputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-output.webm`);
  const mixedOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-mixed.webm`);
  const tempVideoOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-output.mp4`);
  // 裁剪/剪辑产物用 MP4/H.264 高画质输出（而非 webm/VP9 有损重编码），避免发糊。
  const cropClipPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-edit.mp4`);
  const audioOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-audio.wav`);
  const vocalOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-vocal.wav`);
  const accompanimentOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-accompaniment.wav`);
  let linkedAudioPath = null;
  const persistedResultPaths = [];

  try {
    linkedAudioPath = await downloadOrWriteAudioInput(requestId, payload);
    if (inputBase64) {
      await fs.writeFile(inputPath, Buffer.from(inputBase64, 'base64'));
    } else {
      const remote = await downloadRemoteMediaBuffer(sourceUrl);
      await fs.writeFile(inputPath, remote.bytes);
    }
    const sourceMeta = await probeVideoFile(inputPath);
    if (!sourceMeta.width || !sourceMeta.height) {
      throw new Error('local-video-source-metadata-missing');
    }
    const linkedAudioMixMode = String(payload?.audioMixMode || payload?.linkedAudioMixMode || '').trim();
    const linkedAudioGain = clampNumber(payload?.audioGain ?? payload?.linkedAudioGain, 0, 2, 1);
    const linkedVideoGain = clampNumber(payload?.videoGain ?? payload?.linkedVideoGain, 0, 2, linkedAudioMixMode === 'voiceover-dub' ? 0.3 : 0.74);
    let processingEngine = '';

    if (operation === 'crop') {
      const rect = payload?.rect || {};
      // 偶数对齐：yuv420p 要求宽高为偶数，奇数尺寸会被 libvpx/libx264 悄悄缩放导致模糊。
      const even = (value) => Math.max(2, Math.round(value / 2) * 2);
      const cropWidth = even((Number(rect.width || 100) / 100) * sourceMeta.width);
      const cropHeight = even((Number(rect.height || 100) / 100) * sourceMeta.height);
      const cropX = Math.min(sourceMeta.width - cropWidth, even((Number(rect.x || 0) / 100) * sourceMeta.width));
      const cropY = Math.min(sourceMeta.height - cropHeight, even((Number(rect.y || 0) / 100) * sourceMeta.height));

      await runCommand('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-vf',
        `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`,
        ...buildHighQualityMp4Args(cropClipPath, { includeAudio: true }),
      ]);
    } else if (operation === 'clip') {
      const normalizedSegments = normalizeClipSegments(payload?.segments, sourceMeta.duration);
      if (!normalizedSegments.length) {
        throw new Error('local-video-clip-segments-empty');
      }

      if (normalizedSegments.length === 1) {
        // 单段剪辑 = 纯时间裁剪，优先用无损流拷贝(-c copy)，彻底不重编码、不模糊；
        // 若源容器/编码不适配 mp4 导致拷贝失败，回退到高质量 H.264 重编码。
        const start = String(normalizedSegments[0].startTime);
        const duration = String(Number((normalizedSegments[0].endTime - normalizedSegments[0].startTime).toFixed(3)));
        const copyArgs = [
          '-y',
          '-ss', start,
          '-i', inputPath,
          '-t', duration,
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          cropClipPath,
        ];
        try {
          await runCommand('ffmpeg', copyArgs);
        } catch {
          await runCommand('ffmpeg', [
            '-y',
            '-ss', start,
            '-i', inputPath,
            '-t', duration,
            ...buildHighQualityMp4Args(cropClipPath, { includeAudio: true }),
          ]);
        }
      } else {
        // 多段拼接必须重编码，用高质量 H.264（视频；拼接后音频轨道按原逻辑丢弃，与旧实现一致）。
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          inputPath,
          '-filter_complex',
          [
            ...normalizedSegments.map(
              (segment, index) => `[0:v]trim=start=${segment.startTime}:end=${segment.endTime},setpts=PTS-STARTPTS[v${index}]`,
            ),
            `${normalizedSegments.map((_, index) => `[v${index}]`).join('')}concat=n=${normalizedSegments.length}:v=1:a=0[vout]`,
          ].join(';'),
          '-map',
          '[vout]',
          '-c:v', 'libx264',
          '-preset', 'slow',
          '-crf', '16',
          '-pix_fmt', 'yuv420p',
          '-an',
          '-movflags', '+faststart',
          cropClipPath,
        ]);
      }
    } else if (operation === 'hd') {
      const scale = clampNumber(payload?.scale, 1, 4, 2);
      const detailStrength = clampNumber(payload?.detailStrength, 0, 1, 0.58);
      const sharpen = clampNumber(payload?.sharpen, 0, 1, 0.36);
      const targetFps = payload?.interpolate60fps ? 60 : 24;
      const outputWidth = evenSize(sourceMeta.width * scale, sourceMeta.width);
      const outputHeight = evenSize(sourceMeta.height * scale, sourceMeta.height);
      const lumaAmount = Number((0.35 + sharpen * 2.6).toFixed(2));
      const filterChain = [
        `scale=${outputWidth}:${outputHeight}:flags=lanczos`,
        `unsharp=7:7:${lumaAmount}:7:7:0`,
        `fps=${targetFps}`,
      ].join(',');
      await runCommand('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-vf',
        filterChain,
        ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
      ]);
    } else if (operation === 'motionblur') {
      // 真实运动模糊（电影感快门模拟）：
      //   轻量档用 tblend=all_mode=average（相邻帧均值）得到 2 帧曝光的运动拖影；
      //   强档先用 minterpolate 做运动补偿插帧把帧率提到 shutter×fps，再 tblend 均值 +
      //   framestep 抽回原帧率，得到多帧曝光的运动模糊。minterpolate 失败时自动回退到 tblend。
      const fps = clampNumber(payload?.fps ?? sourceMeta.fps ?? 24, 1, 120, 24);
      const strengthNorm = clampNumber(payload?.strength ?? 0.5, 0, 1, 0.5);
      const shutter = Math.max(2, Math.min(12, Math.round(2 + strengthNorm * 8)));
      const simpleFilter = 'tblend=all_mode=average';
      const strongFilter = `minterpolate=fps=${Math.round(fps * shutter)}:mi_mode=blend,tblend=all_mode=average,framestep=${shutter},fps=${fps}`;
      let usedFilter = shutter >= 3 ? strongFilter : simpleFilter;
      let processingEngine = 'ffmpeg-tblend';
      try {
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          inputPath,
          '-vf',
          usedFilter,
          ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
        ]);
      } catch (motionErr) {
        if (usedFilter !== simpleFilter) {
          usedFilter = simpleFilter;
          processingEngine = 'ffmpeg-tblend-fallback';
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vf',
            usedFilter,
            ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
          ]);
        } else {
          throw motionErr;
        }
      }
      const outputMeta = await probeVideoFile(outputPath);
      const persistedVideo = await persistLocalResultFile(LOCAL_VIDEO_RESULT_DIR, outputPath, requestId, 'webm');
      const videoStat = await fs.stat(persistedVideo.persistedPath);
      return {
        format: 'webm',
        mimeType: 'video/webm',
        outputAssetId: persistedVideo.assetId,
        outputUrl: `/api/local-video/result/${encodeURIComponent(persistedVideo.assetId)}`,
        size: Number(videoStat.size || 0),
        width: outputMeta.width,
        height: outputMeta.height,
        duration: outputMeta.duration,
        processingEngine,
      };
    } else if (operation === 'removeSubtitle') {
      const feather = clampNumber(payload?.maskFeather, 0, 32, 8);
      const detectionMode = String(payload?.detectionMode || 'auto').trim();
      const requestedSubtitleEngine = String(payload?.subtitleEngine || 'auto').trim().toLowerCase();
      const rawRegion = payload?.region && typeof payload.region === 'object' ? payload.region : {};
      const manualX = clampNumber(rawRegion?.x ?? payload?.regionX ?? 12, 0, 95, 12);
      const manualY = clampNumber(rawRegion?.y ?? payload?.regionY ?? 80, 0, 95, 80);
      const manualWidth = clampNumber(rawRegion?.width ?? payload?.regionWidth ?? 76, 4, 100 - manualX, 76);
      const manualHeight = clampNumber(rawRegion?.height ?? payload?.regionHeight ?? 12, 4, 100 - manualY, 12);
      let subtitleEngine = 'opencv-telea';
      if (requestedSubtitleEngine === 'video-subtitle-remover') {
        subtitleEngine = 'video-subtitle-remover-requested -> opencv-telea';
      } else if (requestedSubtitleEngine === 'propainter') {
        subtitleEngine = 'propainter-requested -> opencv-telea';
      }
      try {
        await runLocalSubtitleRemoval({
          inputPath,
          tempOutputPath: tempVideoOutputPath,
          detectionMode,
          manualX,
          manualY,
          manualWidth,
          manualHeight,
          feather,
        });
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          tempVideoOutputPath,
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-map',
          '1:a?',
          ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
        ]);
      } catch (pythonRemoveError) {
        subtitleEngine = subtitleEngine.includes('requested')
          ? `${subtitleEngine} -> ffmpeg-patch-blend`
          : 'ffmpeg-patch-blend';
        const autoHeightPercent = 14;
        const regionPercent = detectionMode === 'manual'
          ? { x: manualX, y: manualY, width: manualWidth, height: manualHeight }
          : { x: 0, y: 100 - autoHeightPercent, width: 100, height: autoHeightPercent };
        const expandPx = Math.max(2, Math.round(feather));
        const regionX = Math.max(0, Math.round((regionPercent.x / 100) * sourceMeta.width) - expandPx);
        const regionY = Math.max(0, Math.round((regionPercent.y / 100) * sourceMeta.height) - expandPx);
        const regionWidth = Math.max(16, Math.min(sourceMeta.width - regionX, Math.round((regionPercent.width / 100) * sourceMeta.width) + expandPx * 2));
        const regionHeight = Math.max(16, Math.min(sourceMeta.height - regionY, Math.round((regionPercent.height / 100) * sourceMeta.height) + expandPx * 2));
        const patchSourceY = regionY > regionHeight + expandPx
          ? Math.max(0, regionY - regionHeight)
          : Math.min(Math.max(0, sourceMeta.height - regionHeight), regionY + regionHeight);
        const patchSourceX = Math.max(0, Math.min(sourceMeta.width - regionWidth, regionX));
        const blurSigma = Number(Math.max(0.6, feather / 4).toFixed(2));
        const filterChain = [
          `[0:v]split=2[base][fillsrc]`,
          `[fillsrc]crop=${regionWidth}:${regionHeight}:${patchSourceX}:${patchSourceY},gblur=sigma=${blurSigma}[fill]`,
          `[base][fill]overlay=${regionX}:${regionY}:format=auto[vout]`,
        ].join(';');
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          inputPath,
          '-filter_complex',
          filterChain,
          '-map',
          '[vout]',
          '-map',
          '0:a?',
          ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
        ]);
      }
      const outputMeta = await probeVideoFile(outputPath);
      const persistedVideo = await persistLocalResultFile(LOCAL_VIDEO_RESULT_DIR, outputPath, requestId, 'webm');
      persistedResultPaths.push(persistedVideo.persistedPath);
      const videoStat = await fs.stat(persistedVideo.persistedPath);
      return {
        format: 'webm',
        mimeType: 'video/webm',
        outputAssetId: persistedVideo.assetId,
        outputUrl: `/api/local-video/result/${encodeURIComponent(persistedVideo.assetId)}`,
        size: Number(videoStat.size || 0),
        width: outputMeta.width,
        height: outputMeta.height,
        duration: outputMeta.duration,
        processingEngine: subtitleEngine,
      };
    } else if (operation === 'audioSplit') {
      const keepAudioInVideo = Boolean(payload?.keepVocalInVideo);
      const sourceStreams = await probeMediaStreams(inputPath);
      let splitEngine = 'demucs-v4';
      let processingNotice = '';
      if (!sourceStreams.hasAudio) {
        splitEngine = 'silent-audio-fallback';
        processingNotice = 'source-video-has-no-audio-track';
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          inputPath,
          ...buildWebmEncodeArgs(outputPath, { includeAudio: false }),
        ]);
        await createSilentAudioFile(audioOutputPath, sourceMeta.duration, { sampleRate: 48000, channels: 2 });
        await fs.copyFile(audioOutputPath, vocalOutputPath);
        await fs.copyFile(audioOutputPath, accompanimentOutputPath);
      } else {
        try {
          await runDemucsAudioSplit({
            inputPath,
            requestId,
            outputPath,
            audioOutputPath,
            vocalOutputPath,
            accompanimentOutputPath,
            keepAudioInVideo,
          });
        } catch {
          splitEngine = 'ffmpeg-approximate';
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-acodec',
            'pcm_s16le',
            audioOutputPath,
          ]);
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-af',
            'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=180',
            '-acodec',
            'pcm_s16le',
            vocalOutputPath,
          ]);
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-af',
            'pan=stereo|c0=c0|c1=c1,lowpass=f=220,volume=0.9',
            '-acodec',
            'pcm_s16le',
            accompanimentOutputPath,
          ]);
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            ...(keepAudioInVideo ? [] : ['-an']),
            ...buildWebmEncodeArgs(outputPath, { includeAudio: keepAudioInVideo }),
          ]);
        }
      }
      const [outputMeta, audioMeta, vocalMeta, accompanimentMeta] = await Promise.all([
        probeVideoFile(outputPath),
        probeAudioFile(audioOutputPath),
        probeAudioFile(vocalOutputPath),
        probeAudioFile(accompanimentOutputPath),
      ]);
      const persistedVideo = await persistLocalResultFile(LOCAL_VIDEO_RESULT_DIR, outputPath, `${requestId}-video`, 'webm');
      const persistedAudio = await persistLocalResultFile(LOCAL_AUDIO_RESULT_DIR, audioOutputPath, `${requestId}-audio`, 'wav');
      const persistedVocal = await persistLocalResultFile(LOCAL_AUDIO_RESULT_DIR, vocalOutputPath, `${requestId}-vocal`, 'wav');
      const persistedAccompaniment = await persistLocalResultFile(LOCAL_AUDIO_RESULT_DIR, accompanimentOutputPath, `${requestId}-accompaniment`, 'wav');
      persistedResultPaths.push(
        persistedVideo.persistedPath,
        persistedAudio.persistedPath,
        persistedVocal.persistedPath,
        persistedAccompaniment.persistedPath,
      );
      const [videoStat, audioStat, vocalStat, accompanimentStat] = await Promise.all([
        fs.stat(persistedVideo.persistedPath),
        fs.stat(persistedAudio.persistedPath),
        fs.stat(persistedVocal.persistedPath),
        fs.stat(persistedAccompaniment.persistedPath),
      ]);
      return {
        kind: 'audioSplit',
        format: 'webm',
        mimeType: 'video/webm',
        outputAssetId: persistedVideo.assetId,
        outputUrl: `/api/local-video/result/${encodeURIComponent(persistedVideo.assetId)}`,
        size: Number(videoStat.size || 0),
        width: outputMeta.width,
        height: outputMeta.height,
        duration: outputMeta.duration,
        audioFormat: 'wav',
        audioMimeType: 'audio/wav',
        audioOutputAssetId: persistedAudio.assetId,
        audioOutputUrl: `/api/local-audio/result/${encodeURIComponent(persistedAudio.assetId)}`,
        audioSize: Number(audioStat.size || 0),
        audioDuration: audioMeta.duration,
        audioSampleRate: audioMeta.sampleRate,
        audioChannels: audioMeta.channels,
        vocalFormat: 'wav',
        vocalMimeType: 'audio/wav',
        vocalOutputAssetId: persistedVocal.assetId,
        vocalOutputUrl: `/api/local-audio/result/${encodeURIComponent(persistedVocal.assetId)}`,
        vocalSize: Number(vocalStat.size || 0),
        vocalDuration: vocalMeta.duration,
        vocalSampleRate: vocalMeta.sampleRate,
        vocalChannels: vocalMeta.channels,
        accompanimentFormat: 'wav',
        accompanimentMimeType: 'audio/wav',
        accompanimentOutputAssetId: persistedAccompaniment.assetId,
        accompanimentOutputUrl: `/api/local-audio/result/${encodeURIComponent(persistedAccompaniment.assetId)}`,
        accompanimentSize: Number(accompanimentStat.size || 0),
        accompanimentDuration: accompanimentMeta.duration,
        accompanimentSampleRate: accompanimentMeta.sampleRate,
        accompanimentChannels: accompanimentMeta.channels,
        processingEngine: splitEngine,
        processingNotice,
      };
    } else if (operation === 'parse') {
      const sampleFps = clampNumber(payload?.sampleFps, 1, 10, 2);
      let summary = null;
      try {
        summary = await runLocalParseAnalysis(inputPath, sampleFps, {
          sceneEngine: payload?.sceneEngine,
          semanticEngine: payload?.semanticEngine,
        });
        if (shouldEnhanceVideoParseWithImageInterrogation(payload?.semanticEngine)) {
          summary = await enhanceVideoParseWithImageAnalysis(summary, {
            semanticEngine: payload?.semanticEngine || 'clip-interrogator',
          });
        }
      } catch {
        const sceneCuts = await detectSceneCuts(inputPath, 0.24, 12);
        summary = buildParseSummary(sceneCuts, sourceMeta, sampleFps);
      }
      return {
        kind: 'analysis',
        analysis: {
          ...summary,
          width: sourceMeta.width,
          height: sourceMeta.height,
          duration: sourceMeta.duration,
        },
      };
    } else if (operation === 'audioMix') {
      if (!linkedAudioPath) {
        throw new Error('local-video-linked-audio-missing');
      }
      processingEngine = await mixExternalAudioIntoVideo({
        videoPath: inputPath,
        audioPath: linkedAudioPath,
        outputPath,
        mixMode: linkedAudioMixMode || 'bgm-under',
        audioGain: linkedAudioGain,
        videoGain: linkedVideoGain,
      });
    }

    if (linkedAudioPath && ['crop', 'clip', 'hd', 'removeSubtitle'].includes(operation)) {
      // 裁剪/剪辑产物是 mp4，混音输入/输出都走 cropClipPath；其余仍走 webm 的 outputPath。
      const mixVideoPath = (operation === 'crop' || operation === 'clip') ? cropClipPath : outputPath;
      processingEngine = await mixExternalAudioIntoVideo({
        videoPath: mixVideoPath,
        audioPath: linkedAudioPath,
        outputPath: mixedOutputPath,
        mixMode: linkedAudioMixMode || 'bgm-under',
        audioGain: linkedAudioGain,
        videoGain: linkedVideoGain,
      });
      await fs.rename(mixedOutputPath, mixVideoPath).catch(async () => {
        await fs.copyFile(mixedOutputPath, mixVideoPath);
        await fs.rm(mixedOutputPath, { force: true }).catch(() => {});
      });
    }

    // 裁剪/剪辑产物为 mp4 高画质；其余操作沿用 webm。
    const isMp4Edit = operation === 'crop' || operation === 'clip';
    const resultPath = isMp4Edit ? cropClipPath : outputPath;
    const outputMeta = await probeVideoFile(resultPath);
    const persistedVideo = await persistLocalResultFile(LOCAL_VIDEO_RESULT_DIR, resultPath, requestId, isMp4Edit ? 'mp4' : 'webm');
    persistedResultPaths.push(persistedVideo.persistedPath);
    const videoStat = await fs.stat(persistedVideo.persistedPath);
    return {
      format: isMp4Edit ? 'mp4' : 'webm',
      mimeType: isMp4Edit ? 'video/mp4' : 'video/webm',
      outputAssetId: persistedVideo.assetId,
      outputUrl: `/api/local-video/result/${encodeURIComponent(persistedVideo.assetId)}`,
      size: Number(videoStat.size || 0),
      width: outputMeta.width,
      height: outputMeta.height,
      duration: outputMeta.duration,
      processingEngine,
    };
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    if (!persistedResultPaths.includes(outputPath)) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
    if (!persistedResultPaths.includes(cropClipPath)) {
      await fs.rm(cropClipPath, { force: true }).catch(() => {});
    }
    await fs.rm(mixedOutputPath, { force: true }).catch(() => {});
    if (!persistedResultPaths.includes(audioOutputPath)) {
      await fs.rm(audioOutputPath, { force: true }).catch(() => {});
    }
    if (!persistedResultPaths.includes(vocalOutputPath)) {
      await fs.rm(vocalOutputPath, { force: true }).catch(() => {});
    }
    if (!persistedResultPaths.includes(accompanimentOutputPath)) {
      await fs.rm(accompanimentOutputPath, { force: true }).catch(() => {});
    }
    if (linkedAudioPath) {
      await fs.rm(linkedAudioPath, { force: true }).catch(() => {});
    }
  }
}

async function readUsers() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(normalized);
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // P1-安全：原子写入。先写临时文件再 rename，避免并发/崩溃时 users.json 被截断损坏
  // （原整文件 writeFile 覆盖在写入中途进程崩溃会留下半截 JSON，导致全体用户无法登录）。
  const tmp = `${USERS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(users, null, 2), 'utf8');
  await fs.rename(tmp, USERS_FILE);
}

// 纯认证工具函数已抽离至 lib/auth-utils.mjs（normalizeLocalEmail / isValidLocalEmail /
// hashPassword / verifyPassword / publicUser），经顶部 import 复用，行为零变更。
// sessions / accessSessions / createSession / deleteSessionsForUser 已抽离至
// ./lib/session-store.mjs（顶部 import 复用）。以下依赖其或 send 的函数仍保留在此，
// 并经由 deps 注入到 auth / cobuild 等路由组。

function sendAuthError(res, status, code, message, extra = {}) {
  return send(res, status, {
    success: false,
    error: {
      code,
      message,
      ...extra,
    },
  });
}

// ---- 需求共建（打赏 + 反馈留言）数据与鉴权 ----

async function readCobuild() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(COBUILD_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeCobuild(entries) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(COBUILD_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

function maskEmailForDisplay(email = '') {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 0) return value || '匿名用户';
  const name = value.slice(0, at);
  const domain = value.slice(at);
  if (name.length <= 1) return `${name}***${domain}`;
  if (name.length <= 3) return `${name[0]}***${domain}`;
  return `${name.slice(0, 2)}***${name.slice(-1)}${domain}`;
}

// 从请求中解析当前登录用户（基于 access token）。
// 前端在 Authorization: Bearer <token> 或在请求体携带 access_token。
function getUserFromRequest(req, body = {}) {
  const headerToken = req.headers['authorization'] || req.headers['Authorization'] || '';
  const bearerMatch = String(headerToken).match(/^Bearer\s+(.+)$/i);
  const accessToken = bearerMatch ? bearerMatch[1].trim() : (body.access_token || body.accessToken || '').toString().trim();
  if (!accessToken) return null;
  const entry = accessSessions.get(accessToken);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    accessSessions.delete(accessToken);
    return null;
  }
  return entry.userId;
}

// 云端多用户隔离：给定 userId，反向查找该用户当前有效（未过期）的 access token。
// 用于在用户主动 Connect（写连接意图文件）时，把 token 注入意图文件，供本机 Unreal 插件读取后
// 附加到 WS URL，后端据其解析 userId 作为 owner 分桶，避免串流他人引擎。
function getValidTokenForOwner(owner) {
  if (!owner) return '';
  const now = Date.now();
  for (const [token, entry] of accessSessions.entries()) {
    if (entry && entry.userId === owner) {
      if (entry.expiresAt && now > entry.expiresAt) continue;
      return token;
    }
  }
  return '';
}

async function getCobuildUserSafe(userId) {
  const users = await readUsers();
  return users.find((u) => u.id === userId) || null;
}

// ==================== byok 服务（已迁移至 ./services/byokService.mjs） ====================
import { createByokService } from './services/byokService.mjs';
const __byokService = createByokService({
  catalogModelByIdentifier,
  catalogLifecycleFor: (...args) => catalogLifecycleFor(...args), // 惰性：对账服务在 byok 之后接线
  ACTIVATED_PROVIDERS_FILE,
  activatedProviders,
  DATA_DIR,
  providers,
  MODEL_CATALOG,
  extractFirstString,
  escapePowerShellSingleQuoted,
  pickActivatedCloudImageAnalysisRuntime,
});
const {
  maskKey,
  normalizeCatalogIdentifier,
  relayAliasCatalogId,
  resolveActivatedRelayModel,
  isVisionModelId,
  hydrateActivatedProviderRecordsFromDisk,
  persistActivatedProviderRecordsToDisk,
  listActivatedProviderRecords,
  publicActivatedProviderRecord,
  publicImageAnalysisRuntime,
  buildRuntimeRecommendations,
  getActivatedProviderRecord,
  setActivatedProviderRecord,
  isRealApiProxyEnabled,
  deleteActivatedProviderRecord,
  isCatalogModelActivated,
  modelCatalogPayload,
  activatedModelIds,
  modelMatchesIdentifier,
  normalizeRelayEndpointInput,
  relayRequestUrlCandidates,
  relayModelsEndpointCandidates,
  requestRelayModelsEndpoint,
  fetchRelayModelIndex,
  buildRelayActivationRecords,
  validateByokProvider,
  RELAY_CONNECTIVITY_CACHE,
  RELAY_CONNECTIVITY_SUCCESS_TTL_MS,
  RELAY_CONNECTIVITY_FAILURE_TTL_MS,
} = __byokService;
// 目录查找注入对象：将 MODEL_CATALOG 相关状态函数打包，供 apimart-model-kind 模块使用（解耦主文件状态）。
const catalogLookup = { normalizeCatalogIdentifier, catalogModelByIdentifier, relayAliasCatalogId };
// ==================== /byok 服务 ====================
// ==================== 目录对账服务（已迁移至 ./services/catalogReconcile.mjs） ====================
import { createCatalogReconcileService } from './services/catalogReconcile.mjs';
const __reconcileService = createCatalogReconcileService({
  DATA_DIR,
  PROVIDER_BASE_URLS,
  getActivatedProviderRecord,
  normalizeRelayEndpointInput,
  requestRelayModelsEndpoint,
  extractFirstString,
  normalizeCatalogIdentifier,
  hydrateActivatedProviderRecordsFromDisk,
  listActivatedProviderRecords,
});
const {
  reconcileModelCatalog,
  catalogLifecycleFor,
  getCatalogReconcileState,
} = __reconcileService;
// ==================== /目录对账服务 ====================
function parseLatencySeconds(value) {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/(\d+(?:\.\d+)?)s/);
  if (!match) return 999;
  return Number(match[1]);
}

function catalogModelByIdentifier(identifier) {
  const normalizedIdentifier = normalizeCatalogIdentifier(identifier);
  if (!normalizedIdentifier) return null;

  const exact = MODEL_CATALOG.find((item) => (
    [item.id, item.upstreamModel, item.model, item.name]
      .map((value) => normalizeCatalogIdentifier(value))
      .filter(Boolean)
      .includes(normalizedIdentifier)
  ));
  if (exact) return exact;

  const aliasCatalogId = normalizeCatalogIdentifier(relayAliasCatalogId(identifier));
  if (!aliasCatalogId) return null;
  return MODEL_CATALOG.find((item) => normalizeCatalogIdentifier(item.id) === aliasCatalogId) || null;
}

function providerRegionAffinityScore(providerId, regionPreference, weights) {
  if ((regionPreference.preferredProviders || []).includes(providerId)) {
    return Number(weights.regionMatch || 90);
  }
  if ((regionPreference.secondaryProviders || []).includes(providerId)) {
    return Number(weights.regionMismatch || -80);
  }
  return 0;
}

function isKlingVideoModelIdentifier(value = '') {
  const normalized = normalizeCatalogIdentifier(String(value || ''));
  return normalized.includes('kling');
}

function readVideoSourceProfile(primaryAssets = [], sourceMediaType = '') {
  if (String(sourceMediaType || '').trim().toLowerCase() !== 'video') return null;
  const primaryVideo = primaryAssets.find((item) => item?.type === 'video' && (item.channel === 'primary' || item.role === 'motion' || item.uiRole === 'primary'));
  const sourceMeta = primaryVideo?.sourceMeta && typeof primaryVideo.sourceMeta === 'object' ? primaryVideo.sourceMeta : null;
  const width = Number(sourceMeta?.width || 0);
  const height = Number(sourceMeta?.height || 0);
  const duration = Number(sourceMeta?.duration || 0);
  if (!(Number.isFinite(width) || Number.isFinite(height) || Number.isFinite(duration))) return null;
  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
  };
}

function buildVideoRouteConstraint({
  catalogItem = null,
  sourceMediaType = '',
  activatedRecord = null,
} = {}) {
  if (String(sourceMediaType || '').trim().toLowerCase() !== 'video') return null;
  if (!catalogItem || typeof catalogItem !== 'object') return null;
  if (!isApimartRelayEndpoint(activatedRecord?.endpoint || '')) return null;
  if (normalizeCatalogIdentifier(catalogItem.id || catalogItem.upstreamModel || '').includes('seedance')) {
    return {
      kind: 'apimart-seedance-video-edit-advisory',
      severity: 'warn',
      reason: 'Current APIMart Seedance V2 routing still needs contract verification for primary-video editing and video_urls submission. Keep explicit Seedance requests intact, but verify the preview contract before spending a paid run.',
      recommendedModels: ['seedance-v2', 'kling-v3-omni', 'wan2.2-i2v-plus'],
    };
  }
  return null;
}

function shouldForceKlingOmniVideoRoute({
  requestedProvider = '',
  requestedModel = '',
  sourceMediaType = '',
  generationMode = '',
  hasImageReference = false,
  hasVideoReference = false,
  requiresAdvancedReferenceControl = false,
} = {}) {
  const normalizedProvider = String(requestedProvider || '').trim().toLowerCase();
  const normalizedRequestedModel = normalizeCatalogIdentifier(requestedModel || '');
  if (normalizedRequestedModel && !isKlingVideoModelIdentifier(normalizedRequestedModel)) return false;
  if (normalizedProvider !== 'kling') return false;
  if (String(sourceMediaType || '').trim().toLowerCase() !== 'video') return false;
  const normalizedGenerationMode = String(generationMode || '').trim();
  if (!['referenceVideo', 'videoStyleTransfer'].includes(normalizedGenerationMode)) return false;
  return Boolean(hasImageReference || hasVideoReference || requiresAdvancedReferenceControl);
}

function shouldPreserveRequestedModelIdentifier(requestedModel = '', catalogItem = null) {
  const normalizedRequested = normalizeCatalogIdentifier(requestedModel || '');
  if (!normalizedRequested || !catalogItem || typeof catalogItem !== 'object') {
    return Boolean(normalizedRequested);
  }
  const normalizedCatalogId = normalizeCatalogIdentifier(catalogItem.id || '');
  const normalizedUpstream = normalizeCatalogIdentifier(catalogItem.upstreamModel || '');
  if (normalizedCatalogId && normalizedRequested === normalizedCatalogId && normalizedUpstream && normalizedUpstream !== normalizedCatalogId) {
    return false;
  }
  return true;
}

async function resolveImageOperationDispatch(body = {}, requestedProvider = '', requestedModel = '') {
  const toolOperation = String(body?.tool_operation || '').trim();
  const conditioningOperation = String(body?.conditioning_strategy?.operation || '').trim();
  const operation = toolOperation || conditioningOperation;
  const dispatchConfig = await loadOperationDispatchConfig();
  const strategy = dispatchConfig?.operations?.[operation] || IMAGE_OPERATION_DISPATCH[operation];
  if (!strategy) {
    return {
      provider: requestedProvider,
      model: requestedModel,
      operation,
      strategy: null,
      dispatchMode: 'requested',
    };
  }

  const globalWeights = dispatchConfig?.global?.weights || {};
  const regionHint = String(body?.region_hint || process.env.HMDAO_REGION_HINT || 'CN').toUpperCase();
  const regionPreference = dispatchConfig?.global?.regionPreference?.[regionHint] || dispatchConfig?.global?.regionPreference?.OTHER || {};
  const primaryAssets = normalizeReferenceAssets(body?.primary_assets);
  const referenceAssets = normalizeReferenceAssets(body?.reference_assets);
  const routingAssets = [...primaryAssets, ...referenceAssets];
  const identityController = normalizeIdentityController(body?.identity_controller);
  const referenceRouting = dispatchConfig?.global?.referenceRouting?.image || {};
  const coverageOptions = { imageStrategyOperation: conditioningOperation };
  const capabilityRequirements = [
    ...(toolOperation ? [{ key: 'toolOperation', value: toolOperation }] : []),
    ...routingAssets.flatMap((asset) => expandedReferenceRoles(asset, coverageOptions).map((role) => ({ key: 'referenceRole', value: role }))),
    ...(identityController.enabled && identityController.identityLockMode !== 'off' ? [{ key: 'supportsIdentityController', value: true }] : []),
  ];
  const disabledModels = new Set([
    ...(dispatchConfig?.global?.disabledModels || []),
    ...(strategy?.disabledModels || []),
  ]);

  const candidateModels = (strategy.candidates || [])
    .map((modelId) => catalogModelByIdentifier(modelId))
    .filter((item) => item && item.mode === 'image');
  const activatedModels = activatedModelIds();

  const exactMatch = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, requestedModel) && item.provider === requestedProvider && item.mode === 'image');
  const requested = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, requestedModel) && item.mode === 'image');
  const providerRequested = requestedProvider
    ? MODEL_CATALOG.find((item) => item.provider === requestedProvider && item.mode === 'image')
    : undefined;

  if (exactMatch) {
    const preserveRequestedModel = shouldPreserveRequestedModelIdentifier(requestedModel, exactMatch);
    return {
      provider: exactMatch.provider,
      model: preserveRequestedModel
        ? (requestedModel || exactMatch.upstreamModel || exactMatch.id)
        : (exactMatch.upstreamModel || exactMatch.id || requestedModel),
      operation,
      strategy,
      dispatchMode: 'requested',
    };
  }

  const ranked = [exactMatch, requested, providerRequested, ...candidateModels]
    .filter((item, index, array) => item && array.findIndex((entry) => entry?.id === item.id) === index)
    .map((item) => {
      const activationScore = isCatalogModelActivated(item) || activatedModels.has(item.id) || activatedModels.has(item.upstreamModel)
        ? Number(globalWeights.activation || 1200)
        : 0;
      const preferredModelScore = (strategy.candidates || []).includes(item.id) || (strategy.candidates || []).includes(item.upstreamModel)
        ? Number(globalWeights.preferredModel || 260)
        : 0;
      const preferredProviderScore = (strategy.preferredProviders || []).includes(item.provider)
        ? Number(globalWeights.preferredProvider || 140)
        : 0;
      const regionScore = providerRegionAffinityScore(item.provider, regionPreference, globalWeights);
      const referenceScore = referenceRoleRoutingScore(item, routingAssets, referenceRouting, globalWeights, coverageOptions);
      const capabilityScore = capabilityPenalty(item, capabilityRequirements, globalWeights);
      const disabledScore = disabledModels.has(item.id) || disabledModels.has(item.upstreamModel)
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const costScore = Number(item.price || 0) * Number(globalWeights.cost || -22);
      const latencyScore = parseLatencySeconds(item.latency) * Number(globalWeights.latency || -9);

      return {
        item,
        score: activationScore + preferredModelScore + preferredProviderScore + regionScore + referenceScore + capabilityScore + disabledScore + costScore + latencyScore,
      };
    });

  ranked.sort((left, right) => right.score - left.score);

  const chosen = ranked[0]?.item || requested || exactMatch;
  const preserveRequestedModel = chosen && modelMatchesIdentifier(chosen, requestedModel)
    ? shouldPreserveRequestedModelIdentifier(requestedModel, chosen)
    : false;
  return {
    provider: chosen?.provider || requestedProvider,
    model: chosen && modelMatchesIdentifier(chosen, requestedModel)
      ? (preserveRequestedModel
        ? (requestedModel || chosen?.upstreamModel || chosen?.id)
        : (chosen?.upstreamModel || chosen?.id || requestedModel))
      : (chosen?.upstreamModel || chosen?.id || requestedModel),
    operation,
    strategy,
    dispatchMode: chosen && modelMatchesIdentifier(chosen, requestedModel) ? 'requested' : 'operation-dispatch',
  };
}

// 通用文本/脚本/分镜/AI App 节点的 LLM 分发：免费额度优先 + 多模型轮换。
// 镜像 resolveImageOperationDispatch 的评分逻辑，但 LLM 没有 referenceRouting / capabilityRequirements，
// 且额外返回有序 candidates 列表，供 executeGenerationRequest 在主模型失败时自动轮换到下一个。
async function resolveLlmOperationDispatch(body = {}, requestedProvider = '', requestedModel = '') {
  const dispatchConfig = await loadOperationDispatchConfig();
  const strategy = dispatchConfig?.operations?.llm_text || null;
  if (!strategy) {
    return { provider: requestedProvider, model: requestedModel, operation: 'llm_text', strategy: null, dispatchMode: 'requested', candidates: [] };
  }

  const globalWeights = dispatchConfig?.global?.weights || {};
  const regionHint = String(body?.region_hint || process.env.HMDAO_REGION_HINT || 'CN').toUpperCase();
  const regionPreference = dispatchConfig?.global?.regionPreference?.[regionHint] || dispatchConfig?.global?.regionPreference?.OTHER || {};
  const disabledModels = new Set([
    ...(dispatchConfig?.global?.disabledModels || []),
    ...(strategy?.disabledModels || []),
  ]);

  const candidateIndexByIdentifier = new Map();
  (strategy.candidates || []).forEach((modelId, index) => {
    const item = catalogModelByIdentifier(modelId);
    if (item && item.mode === 'llm') candidateIndexByIdentifier.set(item.id, index);
  });
  const candidateModels = [...candidateIndexByIdentifier.keys()]
    .map((id) => MODEL_CATALOG.find((m) => m.id === id))
    .filter((item) => item && item.mode === 'llm');
  const activatedModels = activatedModelIds();

  const exactMatch = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, requestedModel) && item.provider === requestedProvider && item.mode === 'llm');
  const requested = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, requestedModel) && item.mode === 'llm');
  const providerRequested = requestedProvider
    ? MODEL_CATALOG.find((item) => item.provider === requestedProvider && item.mode === 'llm')
    : undefined;

  const ranked = [exactMatch, requested, providerRequested, ...candidateModels]
    .filter((item) => item)
    .filter((item, index, array) => array.findIndex((entry) => entry?.id === item.id) === index)
    .map((item) => {
      const activationScore = (isCatalogModelActivated(item) || activatedModels.has(item.id) || activatedModels.has(item.upstreamModel))
        ? Number(globalWeights.activation || 1200)
        : 0;
      const preferredModelScore = (strategy.candidates || []).includes(item.id) || (strategy.candidates || []).includes(item.upstreamModel)
        ? Number(globalWeights.preferredModel || 260)
        : 0;
      const preferredProviderScore = (strategy.preferredProviders || []).includes(item.provider)
        ? Number(globalWeights.preferredProvider || 140)
        : 0;
      const regionScore = providerRegionAffinityScore(item.provider, regionPreference, globalWeights);
      const disabledScore = (disabledModels.has(item.id) || disabledModels.has(item.upstreamModel))
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const costScore = Number(item.price || 0) * Number(globalWeights.cost || -22);
      const latencyScore = parseLatencySeconds(item.latency) * Number(globalWeights.latency || -9);
      const orderIndex = candidateIndexByIdentifier.has(item.id) ? candidateIndexByIdentifier.get(item.id) : (strategy.candidates || []).length;
      const orderScore = ((strategy.candidates || []).length - orderIndex) * Number(globalWeights.candidateOrder || 30);
      return {
        item,
        score: activationScore + preferredModelScore + preferredProviderScore + regionScore + disabledScore + costScore + latencyScore + orderScore,
      };
    });

  ranked.sort((left, right) => right.score - left.score);

  const orderedCandidates = ranked.map((entry) => {
    const preserve = modelMatchesIdentifier(entry.item, requestedModel) ? shouldPreserveRequestedModelIdentifier(requestedModel, entry.item) : false;
    return {
      provider: entry.item.provider,
      model: preserve ? (requestedModel || entry.item.upstreamModel || entry.item.id) : (entry.item.upstreamModel || entry.item.id || requestedModel),
    };
  });

  const exactActivated = exactMatch && (isCatalogModelActivated(exactMatch) || activatedModels.has(exactMatch.id) || activatedModels.has(exactMatch.upstreamModel));
  const chosen = exactActivated
    ? { provider: exactMatch.provider, model: exactMatch.upstreamModel || exactMatch.id }
    : (orderedCandidates[0]
      || (requested ? { provider: requested.provider, model: requested.upstreamModel || requested.id } : null)
      || { provider: requestedProvider, model: requestedModel });

  return {
    provider: chosen.provider,
    model: chosen.model,
    operation: 'llm_text',
    strategy,
    dispatchMode: exactActivated ? 'requested' : 'operation-dispatch',
    candidates: orderedCandidates,
  };
}

async function resolveVideoOperationDispatch(body = {}, requestedProvider = '', requestedModel = '') {
  const dispatchConfig = await loadOperationDispatchConfig();
  const globalWeights = dispatchConfig?.global?.weights || {};
  const regionHint = String(body?.region_hint || process.env.HMDAO_REGION_HINT || 'CN').toUpperCase();
  const regionPreference = dispatchConfig?.global?.regionPreference?.[regionHint] || dispatchConfig?.global?.regionPreference?.OTHER || {};
  const primaryAssets = normalizeReferenceAssets(body?.primary_assets);
  const referenceAssets = normalizeReferenceAssets(body?.reference_assets);
  const identityController = normalizeIdentityController(body?.identity_controller);
  const conditioningOperation = String(body?.conditioning_strategy?.operation || '').trim();
  const routingAssets = [...primaryAssets, ...referenceAssets];
  const sourceMediaType = String(body?.source_media_type || '').trim().toLowerCase();
  const generationMode = conditioningOperation
    || String(body?.generation_mode || '').trim()
    || (routingAssets.some((item) => item.type === 'video') || sourceMediaType === 'video' ? 'referenceVideo' : routingAssets.some((item) => item.type === 'image') ? 'imageToVideo' : 'textToVideo');
  const referenceRouting = dispatchConfig?.global?.referenceRouting?.video || {};
  const generationModeRouting = dispatchConfig?.global?.referenceRouting?.videoGenerationModes || {};
  const coverageOptions = { imageStrategyOperation: conditioningOperation };
  const primaryVideoProfile = readVideoSourceProfile(primaryAssets, sourceMediaType);
  const sourceConstraint = buildVideoSourceConstraint(primaryVideoProfile);
  const normalizedRequestedModel = normalizeCatalogIdentifier(requestedModel || '');
  const hasExplicitRequestedModel = Boolean(normalizedRequestedModel);
  const hasImageReference = referenceAssets.some((item) => item.type === 'image');
  const hasVideoReference = routingAssets.some((item) => item.type === 'video');
  const expandedReferenceRoleSet = new Set(routingAssets.flatMap((asset) => expandedReferenceRoles(asset, coverageOptions)));
  const hasSubjectReference = expandedReferenceRoleSet.has('subject');
  const hasCompositionReference = expandedReferenceRoleSet.has('composition');
  const hasOmniReference = referenceAssets.some((item) => String(item.role || '').trim().toLowerCase() === 'omni');
  const requiresAdvancedReferenceControl = hasOmniReference
    || (hasSubjectReference && hasCompositionReference)
    || (sourceMediaType === 'video' && hasImageReference)
    || expandedReferenceRoleSet.size >= 3;
  const forcedKlingOmniRoute = shouldForceKlingOmniVideoRoute({
    requestedProvider,
    requestedModel,
    sourceMediaType,
    generationMode,
    hasImageReference,
    hasVideoReference,
    requiresAdvancedReferenceControl,
  });
  const effectiveRequestedModel = forcedKlingOmniRoute ? 'kling-v3-omni' : requestedModel;
  const capabilityRequirements = [
    ...(generationMode ? [{ key: 'generationMode', value: generationMode }] : []),
    ...routingAssets.flatMap((asset) => expandedReferenceRoles(asset, coverageOptions).map((role) => ({ key: 'referenceRole', value: role }))),
    ...(generationMode === 'textToVideo' ? [{ key: 'supportsTextToVideo', value: true }] : []),
    ...(generationMode === 'imageToVideo' ? [{ key: 'supportsImageToVideo', value: true }] : []),
    ...(generationMode === 'firstLastFrame' ? [{ key: 'supportsFirstLastFrame', value: true }] : []),
    ...(generationMode === 'referenceVideo' || hasVideoReference ? [{ key: 'supportsReferenceVideo', value: true }] : []),
    ...(hasImageReference || generationMode === 'imageToVideo' || generationMode === 'firstLastFrame' ? [{ key: 'supportsReferenceImage', value: true }] : []),
    ...(sourceMediaType === 'video' ? [{ key: 'supportsPrimaryVideoMotionLock', value: true }] : []),
    ...(sourceMediaType === 'video' && hasVideoReference ? [{ key: 'supportsActionTransfer', value: true }] : []),
    ...(sourceMediaType === 'video' && hasImageReference ? [{ key: 'supportsVideoStyleTransfer', value: true }] : []),
    ...(requiresAdvancedReferenceControl ? [{ key: 'supportsIdentityController', value: true }] : []),
    ...(identityController.enabled && identityController.identityLockMode !== 'off' ? [{ key: 'supportsIdentityController', value: true }] : []),
  ];
  const requested = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, effectiveRequestedModel) && item.mode === 'video');
  const exactMatch = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, effectiveRequestedModel) && item.provider === requestedProvider && item.mode === 'video');
  const providerRequested = requestedProvider
    ? MODEL_CATALOG.find((item) => item.provider === requestedProvider && item.mode === 'video')
    : undefined;

  const exactMatchRouteConstraint = exactMatch
    ? buildVideoRouteConstraint({
      catalogItem: exactMatch,
      sourceMediaType,
      activatedRecord: getActivatedProviderRecord(exactMatch.provider, 'video'),
    })
    : null;

  const requestedRouteConstraint = requested
    ? buildVideoRouteConstraint({
      catalogItem: requested,
      sourceMediaType,
      activatedRecord: getActivatedProviderRecord(requested.provider, 'video'),
    })
    : null;

  if (
    exactMatch
    && !(sourceConstraint?.severity === 'hard' && isKlingVideoModelIdentifier(exactMatch.upstreamModel || exactMatch.id || effectiveRequestedModel))
    && (hasExplicitRequestedModel || !(exactMatchRouteConstraint?.severity === 'hard'))
  ) {
    const preserveRequestedModel = shouldPreserveRequestedModelIdentifier(effectiveRequestedModel, exactMatch);
    return {
      provider: exactMatch.provider,
      model: preserveRequestedModel
        ? (effectiveRequestedModel || exactMatch.upstreamModel || exactMatch.id)
        : (exactMatch.upstreamModel || exactMatch.id || effectiveRequestedModel),
      operation: generationMode,
      strategy: {
        primaryAssets,
        referenceAssets,
        routingAssets,
        generationMode,
        identityController,
        capabilityRequirements,
        sourceConstraint,
        routeConstraint: exactMatchRouteConstraint,
        primaryVideoProfile,
        forcedModel: forcedKlingOmniRoute ? 'kling-v3-omni' : '',
      },
      dispatchMode: forcedKlingOmniRoute
        ? 'forced-primary-video-kling-omni'
        : hasExplicitRequestedModel
          ? 'explicit-model'
          : 'requested',
    };
  }

  if (
    requested
    && hasExplicitRequestedModel
    && !(sourceConstraint?.severity === 'hard' && isKlingVideoModelIdentifier(requested.upstreamModel || requested.id || effectiveRequestedModel))
  ) {
    const preserveRequestedModel = shouldPreserveRequestedModelIdentifier(effectiveRequestedModel, requested);
    return {
      provider: requested.provider,
      model: preserveRequestedModel
        ? (effectiveRequestedModel || requested.upstreamModel || requested.id)
        : (requested.upstreamModel || requested.id || effectiveRequestedModel),
      operation: generationMode,
      strategy: {
        primaryAssets,
        referenceAssets,
        routingAssets,
        generationMode,
        identityController,
        capabilityRequirements,
        sourceConstraint,
        routeConstraint: requestedRouteConstraint,
        primaryVideoProfile,
        forcedModel: '',
      },
      dispatchMode: 'explicit-model',
    };
  }

  const ranked = [exactMatch, requested, providerRequested, ...MODEL_CATALOG.filter((item) => item.mode === 'video')]
    .filter((item, index, array) => item && array.findIndex((entry) => entry?.id === item.id) === index)
    .map((item) => {
      const activationScore = isCatalogModelActivated(item)
        ? Number(globalWeights.activation || 1200)
        : 0;
      const regionScore = providerRegionAffinityScore(item.provider, regionPreference, globalWeights);
      const referenceScore = referenceRoleRoutingScore(item, routingAssets, referenceRouting, globalWeights, coverageOptions);
      const generationModeScore = videoGenerationModeRoutingScore(item, generationMode, generationModeRouting, globalWeights);
      const capabilityScore = capabilityPenalty(item, capabilityRequirements, globalWeights);
      const unsupportedConditionScore = generationMode === 'videoStyleTransfer' && item.provider === 'siliconflow'
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const routeConstraint = buildVideoRouteConstraint({
        catalogItem: item,
        sourceMediaType,
        activatedRecord: getActivatedProviderRecord(item.provider, 'video'),
      });
      const sourceConstraintScore = sourceConstraint?.severity === 'hard' && isKlingVideoModelIdentifier(item.upstreamModel || item.id)
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const routeConstraintScore = routeConstraint?.severity === 'hard'
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const costScore = Number(item.price || 0) * Number(globalWeights.cost || -22);
      const latencyScore = parseLatencySeconds(item.latency) * Number(globalWeights.latency || -9);
      return {
        item,
        routeConstraint,
        score: activationScore + regionScore + referenceScore + generationModeScore + capabilityScore + unsupportedConditionScore + sourceConstraintScore + routeConstraintScore + costScore + latencyScore,
      };
    });

  ranked.sort((left, right) => right.score - left.score);
  const chosen = ranked[0]?.item || requested || exactMatch;
  const chosenRouteConstraint = ranked[0]?.routeConstraint || buildVideoRouteConstraint({
    catalogItem: chosen,
    sourceMediaType,
    activatedRecord: chosen ? getActivatedProviderRecord(chosen.provider, 'video') : null,
  });
  const preserveRequestedModel = chosen && modelMatchesIdentifier(chosen, effectiveRequestedModel)
    ? shouldPreserveRequestedModelIdentifier(effectiveRequestedModel, chosen)
    : false;
  return {
    provider: chosen?.provider || requestedProvider,
    model: chosen && modelMatchesIdentifier(chosen, effectiveRequestedModel)
      ? (preserveRequestedModel
        ? (effectiveRequestedModel || chosen?.upstreamModel || chosen?.id)
        : (chosen?.upstreamModel || chosen?.id || effectiveRequestedModel))
      : (chosen?.upstreamModel || chosen?.id || effectiveRequestedModel),
    operation: generationMode,
    strategy: {
      primaryAssets,
      referenceAssets,
      routingAssets,
      generationMode,
      identityController,
      capabilityRequirements,
      sourceConstraint,
      routeConstraint: chosenRouteConstraint,
      primaryVideoProfile,
      forcedModel: forcedKlingOmniRoute ? 'kling-v3-omni' : '',
    },
    dispatchMode: forcedKlingOmniRoute
      ? 'forced-primary-video-kling-omni'
      : chosen && modelMatchesIdentifier(chosen, effectiveRequestedModel)
        ? 'requested'
        : sourceConstraint?.severity === 'hard'
          ? 'source-constraint-fallback'
          : 'reference-routing',
  };
}

function normalizeMediaDataUrl(buffer, contentType = 'application/octet-stream') {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

const ASSET_HASH_LARGE_FILE_BYTES = 50 * 1024 * 1024;
const ASSET_HASH_SAMPLE_BYTES = 4 * 1024 * 1024;

// 抽取视频指定时间点的单帧（缩放后）哈希，避免整文件读取造成的超大视频卡顿。
async function captureVideoFrameHash(filePath, seekSeconds = 0, maxBytes = 8 * 1024 * 1024) {
  try {
    const ffmpegPath = String(process.env.HMDAO_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
    const seek = Math.max(0, Number(seekSeconds) || 0);
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = spawn(ffmpegPath, [
        '-loglevel', 'error',
        '-ss', seek.toFixed(3),
        '-i', String(filePath),
        '-vf', 'scale=320:-1',
        '-frames:v', '1',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-',
      ]);
      const chunks = [];
      let total = 0;
      child.stdout.on('data', (chunk) => {
        if (total >= maxBytes) return;
        const take = Math.min(chunk.length, maxBytes - total);
        chunks.push(chunk.subarray(0, take));
        total += take;
        if (total >= maxBytes) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      });
      child.on('error', () => finish(''));
      child.on('close', () => {
        if (chunks.length === 0) return finish('');
        try {
          finish(sha256(Buffer.concat(chunks)));
        } catch {
          finish('');
        }
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 20000);
      if (timer.unref) timer.unref();
    });
  } catch {
    return '';
  }
}

// 视频内容级去重：多关键帧采样哈希（10% / 50% / 90% 三点），降低仅首帧相同的漏判。
// 折中方案：多帧哈希 + 尺寸 + 时长，既能区分不同视频，又把开销控制在少量帧采样范围内。
// 无有效时长时退化为首帧单点采样，保持向后兼容。
async function computeVideoFirstFrameHash(filePath, options = {}) {
  const duration = Math.max(0, Number(options?.duration) || 0);
  const maxBytes = Number(options?.maxBytes) || 8 * 1024 * 1024;
  const timepoints = duration > 1
    ? [duration * 0.1, duration * 0.5, duration * 0.9]
    : [0];
  const hashes = [];
  for (const point of timepoints) {
    // 串行采样，避免同时启动多个 ffmpeg 进程造成资源峰值
    // eslint-disable-next-line no-await-in-loop
    const frameHash = await captureVideoFrameHash(filePath, point, maxBytes);
    hashes.push(frameHash || '');
  }
  if (hashes.every((entry) => !entry)) return '';
  return sha256(hashes.join('|'));
}

// 内容指纹哈希：对大文件/视频采用折中策略，避免整文件读取。
// - 视频：首帧哈希 + 尺寸 + 时长（contentHash 优先于 URL/路径去重）
// - 大文件（>50MB）：仅取样前 4MB + 尺寸
// - 普通文件：整文件 SHA-256
async function computeAssetContentHash(filePath, options = {}) {
  const normalizedPath = String(filePath || '');
  if (!normalizedPath) return '';
  const type = String(options.type || '').trim();
  const duration = Math.max(0, Number(options.duration || 0)) || 0;
  try {
    const stat = await fs.stat(normalizedPath);
    const size = Number(stat.size || 0);
    if (type === 'video') {
      const frameHash = await computeVideoFirstFrameHash(normalizedPath, { duration });
      return sha256(`video:${size}:${duration}:${frameHash}`);
    }
    if (size > ASSET_HASH_LARGE_FILE_BYTES) {
      const fd = await fs.open(normalizedPath, 'r');
      try {
        const sample = Buffer.alloc(Math.min(ASSET_HASH_SAMPLE_BYTES, size));
        const { bytesRead } = await fd.read(sample, 0, sample.length, 0);
        return sha256(`sample:${size}:${sha256(sample.subarray(0, bytesRead))}`);
      } finally {
        await fd.close().catch(() => {});
      }
    }
    const buffer = await fs.readFile(normalizedPath);
    return sha256(buffer);
  } catch {
    return '';
  }
}

// 基于已落库目录计算重复分组（以 contentHash 优先）。
// 返回每组的规范项 canonicalId 及其所有重复项 duplicateIds。
function buildAssetLibraryDuplicateGroups(items = []) {
  const seen = new Map();
  const groups = [];
  for (const item of items) {
    const fingerprint = buildAssetDuplicateFingerprint(item);
    if (!fingerprint) continue;
    const existing = seen.get(fingerprint);
    if (existing) {
      existing.duplicateIds.push(String(item.id || ''));
    } else {
      seen.set(fingerprint, {
        canonicalId: String(item.id || ''),
        type: String(item.type || ''),
        name: String(item.name || ''),
        contentHash: String(item.contentHash || ''),
        duplicateIds: [],
      });
    }
  }
  for (const group of seen.values()) {
    if (group.duplicateIds.length > 0) groups.push(group);
  }
  return groups;
}

function svgDataUrl(prompt, provider, mode) {
  const title = mode === 'video' ? 'HMDao Video Plan' : mode === 'image' ? 'HMDao Image' : 'HMDao Result';
  const esc = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#101827"/>
        <stop offset="0.5" stop-color="#0f766e"/>
        <stop offset="1" stop-color="#1f2937"/>
      </linearGradient>
    </defs>
    <rect width="1280" height="720" fill="url(#g)"/>
    <circle cx="1020" cy="160" r="120" fill="#22d3ee" opacity="0.16"/>
    <circle cx="250" cy="560" r="170" fill="#f59e0b" opacity="0.14"/>
    <text x="80" y="130" fill="#e5f9f6" font-family="Arial, sans-serif" font-size="54" font-weight="700">${title}</text>
    <text x="80" y="198" fill="#a7f3d0" font-family="Arial, sans-serif" font-size="26">${esc(provider)} / ${esc(mode)}</text>
    <foreignObject x="80" y="260" width="1120" height="260">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font: 38px Arial, sans-serif; color: #ffffff; line-height: 1.35; word-break: break-word;">${esc(prompt)}</div>
    </foreignObject>
    <text x="80" y="650" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="22">Generated by local HMDao API fallback</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function normalizeProviderPayload(provider, mode, body = {}) {
  const payload = body && typeof body === 'object' ? stripInternalGenerationFields(body) : {};
  const aspectRatio = normalizeAspectRatio(payload.aspect_ratio, mode === 'image' ? '1:1' : '16:9');
  const width = Number(payload.width);
  const height = Number(payload.height);
  const count = Number(payload.count);
  const sanitized = compactObject({
    ...payload,
    aspect_ratio: aspectRatio,
    width: Number.isFinite(width) ? Math.max(256, Math.min(4096, Math.round(width))) : undefined,
    height: Number.isFinite(height) ? Math.max(256, Math.min(4096, Math.round(height))) : undefined,
    steps: Number.isFinite(Number(payload.steps)) ? Math.max(1, Math.min(80, Math.round(Number(payload.steps)))) : undefined,
    fps: Number.isFinite(Number(payload.fps)) ? Math.max(8, Math.min(60, Math.round(Number(payload.fps)))) : undefined,
    duration: Number.isFinite(Number(payload.duration)) ? Math.max(1, Math.min(30, Math.round(Number(payload.duration)))) : undefined,
    count: Number.isFinite(count) ? Math.max(1, Math.min(4, Math.round(count))) : undefined,
  });

  if (provider === 'replicate') {
    return compactObject({
      ...sanitized,
      input: compactObject({
        prompt: sanitized.prompt,
        image: sanitized.source_url,
        first_frame_image: sanitized.first_frame_url || sanitized.source_url,
        last_frame_image: sanitized.last_frame_url,
        reference_image: sanitized.reference_image_url,
        reference_video: sanitized.reference_video_url,
        aspect_ratio: sanitized.aspect_ratio,
        width: sanitized.width,
        height: sanitized.height,
        num_inference_steps: sanitized.steps,
        num_frames: sanitized.duration && sanitized.fps ? sanitized.duration * sanitized.fps : undefined,
        num_outputs: mode === 'image' ? sanitized.count : undefined,
      }),
      count: undefined,
    });
  }

  if (provider === 'fal') {
    return compactObject({
      ...sanitized,
      image_url: sanitized.source_url,
      first_frame_image_url: sanitized.first_frame_url || sanitized.source_url,
      last_frame_image_url: sanitized.last_frame_url,
      reference_image_url: sanitized.reference_image_url,
      reference_video_url: sanitized.reference_video_url,
      guidance_scale: Number.isFinite(Number(payload.guidance_scale)) ? Number(payload.guidance_scale) : undefined,
      num_images: mode === 'image' ? sanitized.count : undefined,
      count: undefined,
    });
  }

  if (provider === 'openai') {
    return compactObject({
      model: sanitized.model,
      prompt: sanitized.prompt,
      size: sanitized.width && sanitized.height ? `${sanitized.width}x${sanitized.height}` : sanitized.resolution,
      quality: sanitized.quality === 'hd' || sanitized.quality === '2k' ? 'high' : sanitized.quality,
      n: sanitized.count,
    });
  }

  if (provider === 'siliconflow' || provider === 'bailian' || provider === 'zhipu' || provider === 'modelscope' || provider === 'volcengine') {
    return compactObject({
      ...sanitized,
      n: sanitized.count,
      count: undefined,
    });
  }

  if (provider === 'kling') {
    return compactObject({
      ...sanitized,
      image: sanitized.source_url,
      first_frame_image: sanitized.first_frame_url || sanitized.source_url,
      last_frame_image: sanitized.last_frame_url,
      reference_image: sanitized.reference_image_url,
      reference_video: sanitized.reference_video_url,
      mode,
      count: undefined,
    });
  }

  return sanitized;
}

function validateGenerationRequest({ provider, endpoint, method = 'POST', body = {} }) {
  if (!provider || typeof provider !== 'string') {
    return { ok: false, error: { code: 'validation_error', message: 'provider is required.' } };
  }
  if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
    return { ok: false, error: { code: 'validation_error', message: 'endpoint must start with /.' } };
  }
  const mode = inferMode(endpoint);
  if (!providers.some((item) => item.id === provider)) {
    return { ok: false, error: { code: 'validation_error', message: `Unknown provider: ${provider}.` } };
  }
  if (method !== 'POST' && method !== 'GET' && method !== 'PUT' && method !== 'DELETE') {
    return { ok: false, error: { code: 'validation_error', message: `Unsupported method: ${method}.` } };
  }
  if (mode === 'llm') {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) {
      return { ok: false, error: { code: 'validation_error', message: 'LLM request requires messages.' } };
    }
  } else {
    if (!body?.model || !body?.prompt) {
      return { ok: false, error: { code: 'validation_error', message: `${mode} request requires model and prompt.` } };
    }
  }
  return { ok: true, mode };
}

function generationToolMetadata(body = {}) {
  return compactObject({
    imageTool: body?.image_tool,
    videoTool: body?.video_tool,
    generationMode: body?.generation_mode,
    motionPreset: body?.motion_preset,
    stylePreset: body?.style_preset,
    motionStrength: body?.motion_strength,
    consistencyStrength: body?.consistency_strength,
    referenceWeight: body?.reference_weight,
    firstFrameUrl: body?.first_frame_url,
    lastFrameUrl: body?.last_frame_url,
    primaryAssets: Array.isArray(body?.primary_assets) ? body.primary_assets : undefined,
    referenceImageUrl: body?.reference_image_url,
    referenceVideoUrl: body?.reference_video_url,
    referenceAssets: Array.isArray(body?.reference_assets) ? body.reference_assets : undefined,
    referenceSummary: body?.reference_summary,
    conditioningStrategy: body?.conditioning_strategy,
    workflowGraph: body?.workflow_graph,
    identityController: body?.identity_controller,
    sharedMemoryIds: Array.isArray(body?.shared_memory_ids) ? body.shared_memory_ids : undefined,
    sharedMemoryLayers: Array.isArray(body?.shared_memory_layers) ? body.shared_memory_layers : undefined,
    sharedMemoryContext: Array.isArray(body?.shared_memory_context) ? body.shared_memory_context : undefined,
    sharedMemoryRefs: Array.isArray(body?.shared_memory_refs) ? body.shared_memory_refs : undefined,
    linkedAudioUrl: body?.linked_audio_url,
    linkedAudioAssetId: body?.linked_audio_asset_id,
    linkedAudioMode: body?.linked_audio_mode,
    linkedAudioLabel: body?.linked_audio_label,
    linkedAudioBackend: body?.linked_audio_backend,
    audioMixMode: body?.audio_mix_mode,
    audioGain: body?.audio_gain,
    videoGain: body?.video_gain,
    toolOperation: body?.tool_operation,
    toolCapability: body?.tool_capability,
    toolConfig: body?.tool_config,
    basePrompt: body?.base_prompt,
  });
}

function attachGenerationToolMetadata(result, metadata = {}) {
  if (!result || !Object.keys(metadata).length || !result.asset) return result;
  return {
    ...result,
    asset: {
      ...result.asset,
      metadata: {
        ...(result.asset.metadata || {}),
        ...metadata,
      },
    },
    assets: Array.isArray(result.assets)
      ? result.assets.map((asset) => ({
          ...asset,
          metadata: {
            ...(asset?.metadata || {}),
            ...metadata,
          },
        }))
      : result.assets,
  };
}

function normalizeUpstreamPayload({ provider, mode, data, contentType, status }) {
  if (Buffer.isBuffer(data)) {
    return {
      success: true,
      provider,
      mode,
      asset: {
        id: crypto.randomUUID(),
        type: mode === 'video' ? 'video' : mode === 'audio' ? 'audio' : 'image',
        url: normalizeMediaDataUrl(data, contentType),
        metadata: {
          provider,
          upstreamStatus: status,
          bytes: data.length,
          sha256: sha256(data),
          contentType,
          chunkCount: 1,
        },
      },
    };
  }

  const content =
    extractFirstString(data?.choices?.[0]?.message?.content) ||
    extractFirstString(data?.choices?.[0]?.text) ||
    extractFirstString(data?.output_text) ||
    extractFirstString(data?.content) ||
    extractFirstString(data?.text);

  const assetUrl =
    extractFirstString(data?.data?.[0]?.url) ||
    extractFirstString(data?.output?.[0]?.url) ||
    extractFirstString(data?.results?.videos?.[0]?.url) ||
    extractFirstString(data?.result?.url) ||
    extractFirstString(data?.video?.url) ||
    extractFirstString(data?.image?.url);

  const assetBase64 =
    extractFirstString(data?.data?.[0]?.b64_json) ||
    extractFirstString(data?.image?.b64_json);

  const metadata = {
    provider,
    upstreamStatus: status,
    contentType,
    rawKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
  };

  const mediaType = mode === 'video' ? 'video' : mode === 'audio' ? 'audio' : 'image';
  const assetItems = [
    ...(Array.isArray(data?.data) ? data.data : []),
    ...(Array.isArray(data?.output) ? data.output : []),
    ...(Array.isArray(data?.results?.videos) ? data.results.videos : []),
  ]
    .map((item, index) => {
      const itemUrl =
        extractFirstString(item?.url) ||
        extractFirstString(item?.image?.url) ||
        extractFirstString(item?.video?.url);
      const itemBase64 =
        extractFirstString(item?.b64_json) ||
        extractFirstString(item?.image?.b64_json);
      if (!itemUrl && !itemBase64) return null;
      return {
        id: crypto.randomUUID(),
        type: mediaType,
        url: itemUrl || `data:${mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/mpeg'};base64,${itemBase64}`,
        metadata: {
          ...metadata,
          outputIndex: index,
        },
      };
    })
    .filter(Boolean);

  if (assetItems.length > 0) {
    return {
      success: true,
      provider,
      mode,
      content,
      asset: assetItems[0],
      assets: assetItems,
    };
  }

  if (assetUrl || assetBase64) {
    const normalizedUrl = assetUrl || `data:${mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/mpeg'};base64,${assetBase64}`;
    return {
      success: true,
      provider,
      mode,
      content,
      asset: {
        id: crypto.randomUUID(),
        type: mediaType,
        url: normalizedUrl,
        metadata,
      },
    };
  }

  return {
    success: true,
    provider,
    mode,
    content,
    raw: data,
  };
}

function siliconflowVideoImageSize(payload = {}) {
  const width = Number(payload.width);
  const height = Number(payload.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return `${Math.round(width)}x${Math.round(height)}`;
  }

  const quality = String(payload.quality || '').trim().toLowerCase();
  const aspectRatio = normalizeAspectRatio(payload.aspect_ratio || payload.aspectRatio || '16:9', '16:9');
  const presets = {
    '480p': { '16:9': '854x480', '9:16': '480x854', '1:1': '768x768', '4:3': '640x480', '3:4': '480x640' },
    '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024', '4:3': '960x720', '3:4': '720x960' },
    '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1536x1536', '4:3': '1440x1080', '3:4': '1080x1440' },
    '1440p': { '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '2048x2048', '4:3': '1920x1440', '3:4': '1440x1920' },
  };
  const qualityKey = Object.prototype.hasOwnProperty.call(presets, quality) ? quality : '720p';
  return presets[qualityKey][aspectRatio] || presets[qualityKey]['16:9'];
}

function siliconflowVideoModel(payload = {}) {
  const requestedModel = String(payload.model || '').trim();
  if (requestedModel) return requestedModel;
  const generationMode = String(payload.generation_mode || '').trim();
  if (generationMode === 'textToVideo') return 'Wan-AI/Wan2.2-T2V-A14B';
  return 'Wan-AI/Wan2.2-I2V-A14B';
}

function normalizeSiliconflowVideoSubmitBody(payload = {}) {
  const model = siliconflowVideoModel(payload);
  const sourceMediaType = String(payload.source_media_type || '').trim().toLowerCase();
  const sourceUrl = sourceMediaType === 'video' ? '' : extractFirstString(payload.source_url);
  const firstFrameUrl = sourceMediaType === 'video' ? '' : extractFirstString(payload.first_frame_url);
  const conditioningImage =
    firstFrameUrl ||
    sourceUrl ||
    extractFirstString(payload.reference_image_url);

  return compactObject({
    model,
    prompt: payload.prompt,
    image: model.includes('I2V') ? conditioningImage : undefined,
    image_size: siliconflowVideoImageSize(payload),
    num_inference_steps: Number.isFinite(Number(payload.steps)) ? Math.max(1, Math.min(80, Math.round(Number(payload.steps)))) : undefined,
    duration: Number.isFinite(Number(payload.duration)) ? Math.max(1, Math.min(30, Math.round(Number(payload.duration)))) : undefined,
    seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
    negative_prompt: extractFirstString(payload.negative_prompt),
  });
}

async function executeSiliconflowVideoRequest({ baseUrl, apiKey, payload, timeoutMs, signal }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const submitResponse = await fetch(`${baseUrl}/video/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  const submitText = await submitResponse.text();
  let submitData = null;
  try {
    submitData = submitText ? JSON.parse(submitText) : null;
  } catch {
    submitData = { raw: submitText };
  }

  if (!submitResponse.ok) {
    const message = extractFirstString(submitData?.error?.message) || extractFirstString(submitData?.message) || `Upstream request failed with HTTP ${submitResponse.status}.`;
    return {
      success: false,
      provider: 'siliconflow',
      mode: 'video',
      error: {
        message,
        status: submitResponse.status,
        provider: 'siliconflow',
        category: classifyProxyError({ status: submitResponse.status, message }),
        code: extractFirstString(submitData?.error?.code) || '',
      },
      raw: submitData,
    };
  }

  const requestId = extractFirstString(submitData?.requestId) || extractFirstString(submitData?.request_id);
  if (!requestId) {
    return {
      success: false,
      provider: 'siliconflow',
      mode: 'video',
      error: {
        message: 'SiliconFlow video submit did not return a requestId.',
        status: submitResponse.status,
        provider: 'siliconflow',
        category: 'upstream',
      },
      raw: submitData,
    };
  }

  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < timeoutMs) {
    const statusResponse = await fetch(`${baseUrl}/video/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId }),
      signal,
    });
    const statusText = await statusResponse.text();
    let statusData = null;
    try {
      statusData = statusText ? JSON.parse(statusText) : null;
    } catch {
      statusData = { raw: statusText };
    }
    lastStatus = statusData;

    if (!statusResponse.ok) {
      const message = extractFirstString(statusData?.error?.message) || extractFirstString(statusData?.message) || `Video status polling failed with HTTP ${statusResponse.status}.`;
      return {
        success: false,
        provider: 'siliconflow',
        mode: 'video',
        error: {
          message,
          status: statusResponse.status,
          provider: 'siliconflow',
          category: classifyProxyError({ status: statusResponse.status, message }),
          code: extractFirstString(statusData?.error?.code) || '',
        },
        raw: statusData,
      };
    }

    const statusValue = String(statusData?.status || '').trim().toLowerCase();
    if (statusValue === 'succeed' || statusValue === 'success') {
      return normalizeUpstreamPayload({
        provider: 'siliconflow',
        mode: 'video',
        data: {
          requestId,
          ...statusData,
        },
        contentType: 'application/json',
        status: 200,
      });
    }
    if (statusValue === 'failed' || statusValue === 'error') {
      const message = extractFirstString(statusData?.reason) || extractFirstString(statusData?.message) || 'Video generation failed upstream.';
      return {
        success: false,
        provider: 'siliconflow',
        mode: 'video',
        error: {
          message,
          status: 502,
          provider: 'siliconflow',
          category: classifyProxyError({ status: 502, message }),
        },
        raw: statusData,
      };
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError'));
      }, { once: true });
    }).catch((error) => {
      if (error?.message === 'AbortError') {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      throw error;
    });
  }

  return {
    success: false,
    provider: 'siliconflow',
    mode: 'video',
    error: {
      message: `Upstream request timed out after ${timeoutMs}ms.`,
      status: 0,
      provider: 'siliconflow',
      code: 'timeout',
      category: 'timeout',
    },
    raw: lastStatus,
  };
}

function getRealProxyBypassReason(provider, body = {}) {
  const inferredMode = inferMode(body?.endpoint || '');
  const activatedRecord = getActivatedProviderRecord(provider, inferredMode);
  const activatedApiKey = activatedRecord?.apiKey || '';
  const requestApiKey = body.apiKey || activatedApiKey;
  const litellmBaseUrl = String(process.env.HMDAO_LITELLM_BASE_URL || '').trim().replace(/\/$/, '');
  const baseUrl = litellmBaseUrl || normalizeRelayEndpointInput(body.baseUrl || activatedRecord?.endpoint || PROVIDER_BASE_URLS[provider] || '');

  if (!isRealApiProxyEnabled()) {
    return {
      code: 'real-api-disabled',
      category: 'routing',
      provider,
      mode: inferredMode,
      message: '当前 HMDao API 服务还没有可用的真实上游代理配置。请先在 API 管理页激活可用平台或设置 HMDAO_REAL_API=1 启动后端',
      detail: {
        realApiEnabled: false,
        hasActivatedProviderRecord: Boolean(activatedRecord),
        hasProviderApiKey: Boolean(requestApiKey || process.env.HMDAO_LITELLM_API_KEY),
        hasBaseUrl: Boolean(baseUrl),
      },
    };
  }

  if (!requestApiKey && !process.env.HMDAO_LITELLM_API_KEY) {
    return {
      code: 'missing-api-key',
      category: 'auth',
      provider,
      mode: inferredMode,
      message: '当前 provider 没有可用 API Key，真实上游请求没有发出',
      detail: {
        realApiEnabled: true,
        hasActivatedProviderRecord: Boolean(activatedRecord),
        hasProviderApiKey: false,
        hasBaseUrl: Boolean(baseUrl),
      },
    };
  }

  if (!baseUrl) {
    return {
      code: 'missing-base-url',
      category: 'routing',
      provider,
      mode: inferredMode,
      message: '当前 provider 没有可用 Base URL，真实上游请求没有发出',
      detail: {
        realApiEnabled: true,
        hasActivatedProviderRecord: Boolean(activatedRecord),
        hasProviderApiKey: true,
        hasBaseUrl: false,
      },
    };
  }

  return null;
}

async function realProxy(provider, body) {
  if (getRealProxyBypassReason(provider, body)) return null;
  const inferredMode = inferMode(body?.endpoint || '');
  const activatedRecord = getActivatedProviderRecord(provider, inferredMode);
  const activatedApiKey = activatedRecord?.apiKey || '';
  const requestApiKey = body.apiKey || activatedApiKey;
  const litellmBaseUrl = String(process.env.HMDAO_LITELLM_BASE_URL || '').trim().replace(/\/$/, '');
  const baseUrl = litellmBaseUrl || normalizeRelayEndpointInput(body.baseUrl || activatedRecord?.endpoint || PROVIDER_BASE_URLS[provider] || '');
  const isApimartAsyncRequest = isApimartAsyncGenerationRequest(baseUrl, body?.endpoint, inferredMode, body, provider);
  const requestedTimeoutMs = Number(body.timeout || 90000);
  const controllerTimeoutMs = isApimartAsyncRequest
    ? Math.max(requestedTimeoutMs + 15000, 120000)
    : requestedTimeoutMs;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), controllerTimeoutMs);
  try {
    const validation = validateGenerationRequest({
      provider,
      endpoint: body.endpoint,
      method: body.method || 'POST',
      body: body.body || {},
    });
    if (!validation.ok) {
      return {
        success: false,
        provider,
        mode: inferMode(body.endpoint),
        error: {
          code: validation.error.code,
          category: 'validation',
          message: validation.error.message,
          provider,
          status: 400,
        },
      };
    }

    const rawRequestBody = body.body && typeof body.body === 'object' ? body.body : {};
    const normalizedBody = normalizeProviderPayload(provider, validation.mode, rawRequestBody);
    const upstreamBody = body.body && typeof body.body === 'object' ? normalizedBody : body.body;
    const providerApiKey = body.apiKey || getActivatedProviderRecord(provider, validation.mode)?.apiKey || '';

    // 火山方舟聚合模型：model 字段必须是用户接入点 ID（ep-xxxx）。
    // 优先用前端显式传的 endpointModel（外层或内层 body 均可），否则查两处缓存：
    //   1) 按 catalog model id（modelId），2) 按内层 body.model 反查目录条目 id/upstreamModel。
    if (provider === 'volcengine' && upstreamBody && typeof upstreamBody === 'object') {
      const requestedModelId = extractFirstString(body.modelId) || extractFirstString(rawRequestBody.modelId);
      const requestedUpstream = extractFirstString(upstreamBody.model);
      let arkEp = extractFirstString(body.endpointModel) || extractFirstString(rawRequestBody.endpointModel)
        || resolveArkModel(requestedModelId, null);
      if (!arkEp && requestedUpstream && !/^ep-/i.test(requestedUpstream)) {
        const catalogHit = MODEL_CATALOG.find((m) => m.provider === 'volcengine'
          && (normalizeCatalogIdentifier(m.id) === normalizeCatalogIdentifier(requestedUpstream)
            || normalizeCatalogIdentifier(m.upstreamModel) === normalizeCatalogIdentifier(requestedUpstream)));
        if (catalogHit) arkEp = resolveArkModel(catalogHit.id, null);
      }
      if (arkEp) upstreamBody.model = String(arkEp);
      delete upstreamBody.endpointModel;
      delete upstreamBody.modelId;
    }

    if (provider === 'siliconflow' && validation.mode === 'video') {
      // P0.4：i2v 参考图若是本地相对路径，内联为 data: URL 后再提交云端。
      const siliconflowBody = upstreamBody && typeof upstreamBody === 'object'
        ? await inlineCloudConditioningMedia(upstreamBody, 'video')
        : upstreamBody;
      return await executeSiliconflowVideoRequest({
        baseUrl,
        apiKey: providerApiKey,
        payload: normalizeSiliconflowVideoSubmitBody(siliconflowBody || {}),
        timeoutMs: Number(body.timeout || 180000),
        signal: controller.signal,
      });
    }

    if (isApimartAsyncRequest) {
      const resolvedRelayModel = resolveActivatedRelayModel(activatedRecord, rawRequestBody?.model || upstreamBody?.model || '');
      const apimartPayload = materializePublicRelayPayload(resolvedRelayModel
        ? {
            ...(upstreamBody && typeof upstreamBody === 'object' ? upstreamBody : {}),
            model: resolvedRelayModel,
          }
        : (upstreamBody || {}));
      const apimartRawPayload = materializePublicRelayPayload(resolvedRelayModel
        ? {
            ...(rawRequestBody && typeof rawRequestBody === 'object' ? rawRequestBody : {}),
            model: resolvedRelayModel,
          }
        : rawRequestBody);
      const requestConstraint = buildApimartAsyncRequestConstraint({
        provider,
        mode: validation.mode,
        rawPayload: apimartRawPayload || {},
        payload: apimartPayload || {},
      });
      if (requestConstraint) {
        return {
          success: false,
          provider,
          mode: validation.mode,
          error: {
            message: requestConstraint.message,
            status: 400,
            provider,
            category: requestConstraint.category,
            code: requestConstraint.code,
          },
          raw: {
            requestConstraint,
            rawPayload: apimartRawPayload,
            payload: apimartPayload,
          },
        };
      }
      return await executeApimartAsyncGenerationRequest({
        provider,
        mode: validation.mode,
        baseUrl,
        endpoint: body.endpoint,
        apiKey: providerApiKey,
        payload: apimartPayload,
        rawPayload: apimartRawPayload,
        timeoutMs: requestedTimeoutMs,
        signal: controller.signal,
        userId: getUserFromRequest(req),
      });
    }

    // P0.4：通用云端派发前，把本地 /api/assets/content/<id> 等仅本地可达的
    // 参考图/参考视频引用转换为公网 URL 或 data: URL，云端 API 才能真正读到字节。
    const cloudReadyBody = upstreamBody && typeof upstreamBody === 'object'
      ? await inlineCloudConditioningMedia(upstreamBody, validation.mode)
      : upstreamBody;

    const requestHeaders = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      Authorization: `Bearer ${litellmBaseUrl ? (process.env.HMDAO_LITELLM_API_KEY || providerApiKey) : providerApiKey}`,
      'x-hmdao-provider': provider,
      'x-hmdao-mode': inferMode(body.endpoint),
    };

    if (litellmBaseUrl && providerApiKey) {
      requestHeaders['x-hmdao-provider-key'] = providerApiKey;
    }

    let upstream;
    try {
      upstream = await fetch(`${baseUrl}${body.endpoint}`, {
        method: body.method || 'POST',
        headers: requestHeaders,
        body: JSON.stringify(cloudReadyBody || {}),
        signal: controller.signal,
      });
    } catch (fetchError) {
      if (!shouldUsePowerShellRelayFallback(baseUrl, fetchError)) throw fetchError;
      const fallback = await executePowerShellRelayRequest({
        url: `${baseUrl}${body.endpoint}`,
        method: body.method || 'POST',
        headers: requestHeaders,
        body: cloudReadyBody || {},
        timeoutMs: Number(body.timeout || 90000),
      });
      const contentType = fallback.contentType || 'application/json';
      const status = Number(fallback.status || 0);
      if (contentType.includes('application/json') || contentType.includes('text/json')) {
        let data;
        try {
          data = fallback.body ? JSON.parse(fallback.body) : null;
        } catch {
          data = { raw: fallback.body };
        }
        if (!fallback.ok) {
          const message = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || fallback.message || `Upstream request failed with HTTP ${status}.`;
          return {
            success: false,
            provider,
            mode: inferMode(body.endpoint),
            error: {
              message,
              status,
              provider,
              category: classifyProxyError({ status, message }),
              code: extractFirstString(data?.error?.code) || '',
            },
            raw: data,
          };
        }
        return normalizeUpstreamPayload({ provider, mode: inferMode(body.endpoint), data, contentType, status: status || 200 });
      }
      const text = String(fallback.body || '');
      if (!fallback.ok) {
        const message = text || fallback.message || `Upstream request failed with HTTP ${status}.`;
        return {
          success: false,
          provider,
          mode: inferMode(body.endpoint),
          error: {
            message,
            status,
            provider,
            category: classifyProxyError({ status, message }),
          },
        };
      }
      return normalizeUpstreamPayload({
        provider,
        mode: inferMode(body.endpoint),
        data: { content: text },
        contentType,
        status: status || 200,
      });
    }

    const contentType = upstream.headers.get('content-type') || 'application/json';
    const status = upstream.status;

    if (contentType.includes('application/json') || contentType.includes('text/json')) {
      const text = await upstream.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!upstream.ok) {
        const message = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || `Upstream request failed with HTTP ${status}.`;
        return {
          success: false,
          provider,
          mode: inferMode(body.endpoint),
          error: {
            message,
            status,
            provider,
            category: classifyProxyError({ status, message }),
            code: extractFirstString(data?.error?.code) || '',
          },
          raw: data,
        };
      }
      return normalizeUpstreamPayload({ provider, mode: inferMode(body.endpoint), data, contentType, status });
    }

    if (contentType.startsWith('text/')) {
      const text = await upstream.text();
      if (!upstream.ok) {
        const message = text || `Upstream request failed with HTTP ${status}.`;
        return {
          success: false,
          provider,
          mode: inferMode(body.endpoint),
          error: {
            message,
            status,
            provider,
            category: classifyProxyError({ status, message }),
          },
        };
      }
      return normalizeUpstreamPayload({
        provider,
        mode: inferMode(body.endpoint),
        data: { content: text },
        contentType,
        status,
      });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) {
      return {
        success: false,
        provider,
        mode: inferMode(body.endpoint),
        error: {
          message: `Upstream binary response failed with HTTP ${status}.`,
          status,
          provider,
          category: classifyProxyError({ status, message: `Upstream binary response failed with HTTP ${status}.` }),
        },
      };
    }
    return normalizeUpstreamPayload({
      provider,
      mode: inferMode(body.endpoint),
      data: buffer,
      contentType,
      status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const category = error?.name === 'AbortError' ? 'timeout' : classifyProxyError({ message });
    return {
      success: false,
      provider,
      mode: inferMode(body.endpoint),
      error: {
        message: error?.name === 'AbortError' ? `Upstream request timed out after ${Number(body.timeout || 90000)}ms.` : message,
        status: 0,
        provider,
        code: error?.name === 'AbortError' ? 'timeout' : 'proxy_error',
        category,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeGenerationRequest({ provider, endpoint, method = 'POST', body, timeout, apiKey, baseUrl }) {
  const validation = validateGenerationRequest({ provider, endpoint, method, body: body || {} });
  if (!validation.ok) {
    return {
      success: false,
      provider,
      mode: inferMode(endpoint),
      error: {
        ...validation.error,
        category: 'validation',
        provider,
        status: 400,
      },
    };
  }

  const inferredMode = inferMode(endpoint);
  const operationDispatch = inferredMode === 'image'
    ? await resolveImageOperationDispatch(body || {}, provider, body?.model || '')
    : inferredMode === 'video'
      ? await resolveVideoOperationDispatch(body || {}, provider, body?.model || '')
      : await resolveLlmOperationDispatch(body || {}, provider, body?.model || '');

  const effectiveProvider = operationDispatch.provider || provider;
  const requestedModel = body && typeof body === 'object' ? extractFirstString(body.model) : '';
  const effectiveRequestModel = operationDispatch.model || requestedModel;
  const effectiveBody = body && typeof body === 'object'
    ? {
        ...body,
        model: effectiveRequestModel,
      }
    : body;

  const requestBody = { endpoint, method, body: effectiveBody, timeout, apiKey, baseUrl };
  const activatedRecord = getActivatedProviderRecord(effectiveProvider, validation.mode);
  if (!requestBody.apiKey) {
    requestBody.apiKey = activatedRecord?.apiKey || '';
  }
  if (activatedRecord?.endpoint) {
    requestBody.baseUrl = activatedRecord.endpoint;
  }

  // 通用文本 / AI App 节点：免费额度优先 + 多模型轮换（主模型失败自动切下一个候选）
  let upstream = null;
  let dispatchedProvider = effectiveProvider;
  let dispatchedModel = effectiveRequestModel;
  let dispatchedDispatchMode = operationDispatch.dispatchMode;
  if (inferredMode === 'llm' && Array.isArray(operationDispatch.candidates) && operationDispatch.candidates.length) {
    for (const cand of operationDispatch.candidates) {
      const candProvider = cand.provider || effectiveProvider;
      const candBody = body && typeof body === 'object' ? { ...body, model: cand.model } : body;
      const candRequestBody = { ...requestBody, body: candBody };
      const result = await realProxy(candProvider, candRequestBody);
      if (result && result.success !== false) {
        upstream = result;
        dispatchedProvider = candProvider;
        dispatchedModel = cand.model;
        dispatchedDispatchMode = result.dispatchMode || operationDispatch.dispatchMode || 'operation-dispatch';
        break;
      }
    }
  } else {
    upstream = await realProxy(effectiveProvider, requestBody);
  }

  if (upstream) {
    return attachGenerationToolMetadata(upstream, {
      ...generationToolMetadata(body || {}),
      requestedProvider: provider,
      requestedModel,
      dispatchedProvider,
      dispatchedModel,
      dispatchMode: dispatchedDispatchMode,
      dispatchTechnique: operationDispatch.strategy?.latestTechnique,
      dispatchGenerationMode: operationDispatch.strategy?.generationMode,
      dispatchReferenceAssets: operationDispatch.strategy?.referenceAssets,
      dispatchSourceConstraint: operationDispatch.strategy?.sourceConstraint,
      dispatchRouteConstraint: operationDispatch.strategy?.routeConstraint,
      dispatchPrimaryVideoProfile: operationDispatch.strategy?.primaryVideoProfile,
    });
  }

  const mode = inferMode(endpoint);
  const proxyBypass = getRealProxyBypassReason(effectiveProvider, requestBody);
  const prompt = effectiveBody?.prompt || effectiveBody?.messages?.map((msg) => msg.content).join('\n') || '';
  const asset = {
    id: crypto.randomUUID(),
    type: mode,
    url: mode === 'image' ? svgDataUrl(prompt, effectiveProvider, mode) : undefined,
    kind: mode === 'video' ? 'procedural-video' : undefined,
    prompt,
    metadata: {
      provider: effectiveProvider,
      model: operationDispatch.model || effectiveBody?.model,
      generatedAt: new Date().toISOString(),
      fallback: true,
      workflowFallback: true,
      workflowFallbackReason: proxyBypass?.message || '真实上游代理未返回结果，已回退到本地占位结果',
      fallbackReason: proxyBypass?.message || '真实上游代理未返回结果，已回退到本地占位结果',
      fallbackCategory: proxyBypass?.category || 'routing',
      fallbackCode: proxyBypass?.code || 'real-proxy-unavailable',
      realProxyDebug: proxyBypass?.detail || null,
      requestedProvider: provider,
      requestedModel,
      dispatchedProvider: effectiveProvider,
      dispatchedModel: effectiveRequestModel,
      dispatchMode: operationDispatch.dispatchMode,
      dispatchTechnique: operationDispatch.strategy?.latestTechnique,
      dispatchGenerationMode: operationDispatch.strategy?.generationMode,
      dispatchReferenceAssets: operationDispatch.strategy?.referenceAssets,
      dispatchSourceConstraint: operationDispatch.strategy?.sourceConstraint,
      dispatchRouteConstraint: operationDispatch.strategy?.routeConstraint,
      dispatchPrimaryVideoProfile: operationDispatch.strategy?.primaryVideoProfile,
      ...generationToolMetadata(body || {}),
    },
  };

  const content = mode === 'llm'
    ? `Generated content: ${prompt || 'No prompt provided.'}`
    : undefined;

  return {
    success: true,
    provider: effectiveProvider,
    mode,
    content,
    asset,
    fallbackReason: proxyBypass?.message || '真实上游代理未返回结果，已回退到本地占位结果',
    fallbackCategory: proxyBypass?.category || 'routing',
    fallbackCode: proxyBypass?.code || 'real-proxy-unavailable',
  };
}

async function previewGenerationRequest({ provider, endpoint, method = 'POST', body, timeout, apiKey, baseUrl }) {
  const validation = validateGenerationRequest({ provider, endpoint, method, body: body || {} });
  if (!validation.ok) {
    return {
      success: false,
      provider,
      mode: inferMode(endpoint),
      error: {
        ...validation.error,
        category: 'validation',
        provider,
        status: 400,
      },
    };
  }

  const inferredMode = inferMode(endpoint);
  const operationDispatch = inferredMode === 'image'
    ? await resolveImageOperationDispatch(body || {}, provider, body?.model || '')
    : inferredMode === 'video'
      ? await resolveVideoOperationDispatch(body || {}, provider, body?.model || '')
      : await resolveLlmOperationDispatch(body || {}, provider, body?.model || '');

  const effectiveProvider = operationDispatch.provider || provider;
  const requestedModel = body && typeof body === 'object' ? extractFirstString(body.model) : '';
  const effectiveRequestModel = operationDispatch.model || requestedModel;
  const effectiveBody = body && typeof body === 'object'
    ? {
        ...body,
        model: effectiveRequestModel,
      }
    : body;

  const activatedRecord = getActivatedProviderRecord(effectiveProvider, validation.mode);
  const requestBaseUrl = normalizeRelayEndpointInput(
    baseUrl
    || activatedRecord?.endpoint
    || PROVIDER_BASE_URLS[effectiveProvider]
    || '',
  );
  const requestBody = {
    endpoint,
    method,
    body: effectiveBody,
    timeout,
    apiKey: apiKey || activatedRecord?.apiKey || '',
    baseUrl: requestBaseUrl,
  };
  const normalizedBody = normalizeProviderPayload(effectiveProvider, validation.mode, effectiveBody || {});
  const apimartAsyncRequest = isApimartAsyncGenerationRequest(requestBaseUrl, endpoint, validation.mode, effectiveBody, effectiveProvider);
  const resolvedRelayModel = apimartAsyncRequest
    ? resolveActivatedRelayModel(activatedRecord, effectiveBody?.model || normalizedBody?.model || '')
    : '';
  const previewEffectiveBody = materializePublicRelayPayload(resolvedRelayModel
    ? {
        ...(effectiveBody && typeof effectiveBody === 'object' ? effectiveBody : {}),
        model: resolvedRelayModel,
      }
    : effectiveBody);
  const previewNormalizedBody = materializePublicRelayPayload(resolvedRelayModel
    ? normalizeProviderPayload(effectiveProvider, validation.mode, previewEffectiveBody || {})
    : normalizedBody);
  const upstreamBody = apimartAsyncRequest
    ? normalizeApimartAsyncGenerationPayload({
        provider: effectiveProvider,
        mode: validation.mode,
        endpoint,
        rawPayload: previewEffectiveBody || {},
        payload: previewNormalizedBody || {},
      })
    : previewNormalizedBody;
  const requestConstraint = apimartAsyncRequest
    ? buildApimartAsyncRequestConstraint({
        provider: effectiveProvider,
        mode: validation.mode,
        rawPayload: previewEffectiveBody || {},
        payload: upstreamBody || {},
      })
    : null;
  const proxyBypass = requestConstraint || getRealProxyBypassReason(effectiveProvider, requestBody);
  const connectivityProbe = !proxyBypass && requestBaseUrl
    ? await probeRelayConnectivity(requestBaseUrl, Math.min(Math.max(Number(timeout || 8000), 2000), 8000))
    : null;
  const imageRoleEntries = apimartAsyncRequest && validation.mode === 'image'
    ? buildApimartImageRoleEntries(previewEffectiveBody || {}, previewNormalizedBody || {})
    : undefined;
  const orderedImageUrls = Array.isArray(imageRoleEntries)
    ? buildApimartOrderedImageUrls(imageRoleEntries)
    : undefined;

  return compactObject({
    success: true,
    preview: true,
    provider,
    requestedProvider: provider,
    effectiveProvider,
    mode: validation.mode,
    endpoint,
    requestedModel,
    effectiveModel: effectiveRequestModel,
    dispatchMode: operationDispatch.dispatchMode,
    dispatchTechnique: operationDispatch.strategy?.latestTechnique,
    dispatchGenerationMode: operationDispatch.strategy?.generationMode,
    dispatchRouteConstraint: operationDispatch.strategy?.routeConstraint,
    dispatchReferenceAssets: operationDispatch.strategy?.referenceAssets,
    realProxyEnabled: isRealApiProxyEnabled(),
    apimartAsyncRequest,
    requestConstraint,
    proxyBypass,
    connectivityProbe,
    requestBaseUrl: requestBaseUrl || undefined,
    inputBody: previewEffectiveBody,
    normalizedBody: previewNormalizedBody,
    upstreamBody,
    imageRoleEntries,
    orderedImageUrls,
  });
}

function workflowStatusSnapshot(run) {
  const totalNodes = run.nodes.length;
  const nodeResults = run.nodes.map((node) => run.nodeResults.get(node.node_id) || {
    node_id: node.node_id,
    nodeType: node.nodeType,
    provider: node.provider,
    model: node.model,
    prompt: node.prompt,
    status: 'pending',
  });
  const completedNodes = nodeResults.filter((item) => item.status === 'completed').length;
  const failedNodes = nodeResults.filter((item) => item.status === 'failed').length;
  const progress = totalNodes === 0 ? 100 : Math.max(0, Math.min(100, Math.round(((completedNodes + failedNodes) / totalNodes) * 100)));
  return {
    workflow_id: run.workflowId,
    request_id: run.requestId,
    status: run.status,
    name: run.name,
    total_nodes: totalNodes,
    completed_nodes: completedNodes,
    failed_nodes: failedNodes,
    progress,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    node_results: nodeResults,
    error: run.error || '',
  };
}

function publishWorkflowEvent(run, msgType, extra = {}) {
  const status = workflowStatusSnapshot(run);
  const payload = { ...status, ...extra };
  for (const socket of run.subscribers) {
    sendWs(socket, {
      msg_id: nextMessageId(),
      msg_type: msgType,
      payload,
      ts: Date.now(),
    });
  }
}

function broadcastCatalogUpdate(reason = 'catalog-updated') {
  const payload = {
    reason,
    updated_at: Date.now(),
    models: modelCatalogPayload(),
  };
  for (const socket of catalogSocketSubscriptions.values()) {
    sendWs(socket, {
      msg_id: nextMessageId(),
      msg_type: 'catalog:updated',
      payload,
      ts: Date.now(),
    });
  }
}

async function executeWorkflowRun(run) {
  run.status = 'running';
  run.updatedAt = Date.now();
  publishWorkflowEvent(run, 'workflow:started');

  const completed = new Set();
  const cancelled = () => run.status === 'cancelled';
  const pending = new Map(run.nodes.map((node) => [node.node_id, node]));

  while (pending.size > 0) {
    if (cancelled()) {
      run.updatedAt = Date.now();
      publishWorkflowEvent(run, 'workflow:cancelled');
      return;
    }

    const ready = Array.from(pending.values()).filter((node) =>
      (node.depends_on || []).every((dep) => completed.has(dep)),
    );

    if (!ready.length) {
      run.status = 'failed';
      run.error = 'Workflow dependency cycle or missing dependency prevented execution.';
      run.updatedAt = Date.now();
      publishWorkflowEvent(run, 'workflow:failed');
      return;
    }

    for (const node of ready) {
      pending.delete(node.node_id);
      const startedAt = Date.now();
      const nodeBase = {
        node_id: node.node_id,
        nodeType: node.nodeType,
        provider: node.provider,
        model: node.model,
        prompt: node.prompt,
      };

      run.nodeResults.set(node.node_id, {
        ...nodeBase,
        status: 'running',
        metadata: {
          ...(node.metadata || {}),
          startedAt,
          stage: 'running',
          progress: 10,
        },
      });
      run.updatedAt = Date.now();
      publishWorkflowEvent(run, 'node:started', {
        node_id: node.node_id,
        nodeType: node.nodeType,
        stage: 'running',
        progress: 10,
        message: `Node ${node.node_id} started generation request.`,
      });

      try {
        const result = await executeGenerationRequest({
          provider: node.provider,
          endpoint: node.endpoint,
          method: 'POST',
          body: node.body,
          timeout: node.timeout || 90_000,
          apiKey: node.apiKey || '',
        });

        if (!result.success) {
          throw new Error(result.error?.message || 'Node execution failed. Check the current node configuration or upstream input.');
        }

        run.nodeResults.set(node.node_id, {
          ...nodeBase,
          status: 'completed',
          content: result.content,
          asset: result.asset,
          metadata: {
            ...(node.metadata || {}),
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            stage: 'completed',
            progress: 100,
          },
        });
        completed.add(node.node_id);
        run.updatedAt = Date.now();
        publishWorkflowEvent(run, 'node:completed', {
          node_id: node.node_id,
          nodeType: node.nodeType,
          stage: 'completed',
          progress: Math.max(1, Math.round((completed.size / run.nodes.length) * 100)),
          duration_ms: Date.now() - startedAt,
          message: `Node ${node.node_id} completed generation request.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.nodeResults.set(node.node_id, {
          ...nodeBase,
          status: 'failed',
          error: { message },
          metadata: {
            ...(node.metadata || {}),
            failedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            stage: 'failed',
          },
        });
        run.status = 'failed';
        run.error = message;
        run.updatedAt = Date.now();
        publishWorkflowEvent(run, 'node:failed', {
          node_id: node.node_id,
          nodeType: node.nodeType,
          error: message,
          stage: 'failed',
          progress: Math.max(1, Math.round((completed.size / run.nodes.length) * 100)),
          duration_ms: Date.now() - startedAt,
          message,
        });
        publishWorkflowEvent(run, 'workflow:failed');
        return;
      }
    }
  }

  run.status = 'completed';
  run.updatedAt = Date.now();
  publishWorkflowEvent(run, 'workflow:completed');
}

// ==================== comfy 服务（已迁移至 ./services/comfyService.mjs） ====================
import { createComfyService } from './services/comfyService.mjs';
const __comfyService = createComfyService({
  Busboy,
  extensionFromMimeType,
  sanitizeMultipartFieldName,
  send,
  getRequestOrigin,
  COMFYUI_TEMP_DIR,
  COMFYUI_TEMP_TTL_MS,
  providers,
  https,
});
const {
  handleComfyUiApi,
} = __comfyService;
// ==================== /comfy 服务 ====================
async function handleCuratorPreviewProxy(req, res, url) {
  let target;
  try {
    const raw = String(url.searchParams.get('url') || '').trim();
    if (!raw) return send(res, 400, { success: false, error: { message: 'missing-url' } });
    target = new URL(raw);
  } catch {
    return send(res, 400, { success: false, error: { message: 'invalid-url' } });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return send(res, 400, { success: false, error: { message: 'only-http(s)-allowed' } });
  }
  // SSRF 防护：禁止内网/回环地址
  const host = target.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    || host.endsWith('.local') || host.endsWith('.internal')
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    || /^169\.254\./.test(host)
    || /^127\./.test(host);
  if (isPrivate) {
    return send(res, 400, { success: false, error: { message: 'private-address-blocked' } });
  }
  // 按 host 推断合理 Referer（破解主要站点防盗链的关键）
  const refererMap = {
    'huaban.com': 'https://huaban.com/',
    'hbimg.cn': 'https://huaban.com/',
    'pinimg.com': 'https://www.pinterest.com/',
    'pinterest.com': 'https://www.pinterest.com/',
    'pximg.net': 'https://www.pixiv.net/',
    'pixiv.net': 'https://www.pixiv.net/',
    'pixabay.com': 'https://pixabay.com/',
    'pexels.com': 'https://www.pexels.com/',
    'unsplash.com': 'https://unsplash.com/',
    'images.unsplash.com': 'https://unsplash.com/',
    'artstation.com': 'https://www.artstation.com/',
    'behance.net': 'https://www.behance.net/',
    'mir-s3-cdn-cf.behance.net': 'https://www.behance.net/',
    'deviantart.com': 'https://www.deviantart.com/',
    'freepik.com': 'https://www.freepik.com/',
    'openverse.org': 'https://openverse.org/',
    'commons.wikimedia.org': 'https://commons.wikimedia.org/',
  };
  let referer = '';
  for (const suffix of Object.keys(refererMap)) {
    if (host === suffix || host.endsWith('.' + suffix)) {
      referer = refererMap[suffix];
      break;
    }
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('preview-proxy-timeout')), 15000);
  const upstreamFetch = fetch(target, {
    signal: controller.signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      ...(referer ? { 'Referer': referer } : {}),
    },
  }).catch((err) => ({ __err: err }));
  let upstream = await upstreamFetch;
  if (upstream && typeof upstream.__err !== 'undefined') {
    clearTimeout(t);
    return send(res, 502, { success: false, error: { message: `upstream-${upstream.__err?.message || 'fetch-failed'}` } });
  }
  if (!upstream.ok) {
    clearTimeout(t);
    return send(res, 502, { success: false, error: { message: `upstream-${upstream.status}` } });
  }
  const contentType = upstream.headers.get('content-type') || 'image/jpeg';
  const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=3600';
  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
    : {};
  try {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      ...corsHeaders,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
  } catch (e) {
    clearTimeout(t);
    return send(res, 500, { success: false, error: { message: 'write-head-failed' } });
  }
  const reader = upstream.body.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      try { res.end(); } catch { /* noop */ }
    } finally {
      clearTimeout(t);
    }
  })();
  req.on('close', () => {
    try { controller.abort(new Error('client-disconnected')); } catch { /* noop */ }
    try { reader.cancel(); } catch { /* noop */ }
  });
}

// P1-安全：CORS 白名单收敛。仅允许 HMDAO_CORS_ORIGINS（逗号分隔）内的源跨域，
// 未命中返回空串（下游据此不发送 Access-Control-Allow-Origin，而非危险的 *）。
// 开发期可用 HMDAO_CORS_ORIGINS=* 临时放开（仅本地调试，禁止生产使用）。
function resolveCorsOrigin(incoming) {
  const raw = process.env.HMDAO_CORS_ORIGINS;
  if (!raw) return ''; // 未配置：默认收紧（不跨域放行）
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return incoming || '';
  const origin = incoming || '';
  return list.includes(origin) ? origin : '';
}

async function route(req, res) {
  // 存储请求 Origin 用于 CORS 动态回写，避免 credentials:'include' 与通配符 * 冲突
  res._hmdaoOrigin = resolveCorsOrigin(req.headers.origin || '');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  try {
    // 全部 HTTP 分支已外移至 server/routes/ 下的路由组模块，由路由注册表统一分发：
    // health / auth / byok / models / assets / dcc / comfyui / media / cobuild / search /
    // local-ai / agent。未命中即 404，route() 不再持有任何业务 if 分支。
    if (await apiRouter.dispatch(req, res, url)) return undefined;
    return send(res, 404, { success: false, error: { message: `No route for ${req.method} ${url.pathname}` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[HMDao API] request failed', {
      method: req.method,
      path: url.pathname,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return send(res, localVideoEditStatusCode(message), { success: false, error: { message } });
  }
}

// ===== 路由注册表装配 =====
// route() 中的巨型 if 链正按路由组逐步外移到 server/routes/ 下。
// 依赖以显式注入方式传递，避免子模块反向 import 主文件造成循环依赖。
const apiRouter = createHttpRouter({ name: 'hmdao-api' });

registerHealthRoutes(apiRouter, {
  APP_DIR,
  PORT,
  send,
  readJson,
  isRealApiProxyEnabled,
  buildPlatformInfo,
  buildLocalPostBackendStatus,
  resolveLocalPostOcioBackend,
  resolveLocalPostOiioBackend,
  resolveLocalPostGmicBackend,
  resolveLocalPostUpscaleBackend,
  resolveLocalPostYtDlpBackend,
  resolveLocalPostFlorence2Backend,
  resolveLocalPostAria2Backend,
  resolveLocalPostFfmpegBackend,
  clearLocalPostRuntimeDetectionCache,
  buildLocalPostDoctorReport,
  LOCAL_POST_RUNTIME_INSTALL_JOBS,
  LOCAL_POST_INSTALLABLE_RUNTIMES,
  LOCAL_POST_MANAGED_RUNTIME_DIR,
  toRuntimeInstallJobResponse,
  getRuntimeInstallJob,
  startRuntimeInstallJob,
  uninstallManagedLocalPostRuntime,
  isForbiddenInstallTarget,
  getAvailableDiskBytes,
  getDiskTotalBytes,
  listManagedLocalPostBackups,
  rollbackManagedLocalPostRuntime,
  cleanupManagedLocalPostRuntimeTemp,
});

registerAuthRoutes(apiRouter, {
  send,
  readJson,
  sendAuthError,
  normalizeLocalEmail,
  isValidLocalEmail,
  readUsers,
  writeUsers,
  hashPassword,
  verifyPassword,
  publicUser,
  createSession,
  deleteSessionsForUser,
  sessions,
  randomUUID: () => crypto.randomUUID(),
});

registerExtensionLicenseRoutes(apiRouter, {
  send,
  readJson,
  DATA_DIR,
  readUsers,
  writeUsers,
  hashPassword,
  verifyPassword,
  // 方案 A：供 Edge 扩展查询本机 yt-dlp 状态（原生主机握手接口用）。
  // 直接复用既有的托管目录探测函数，零新增探测逻辑。
  detectYtDlpStatus: () => {
    const p = detectManagedLocalPostYtDlpPath();
    if (p) return Promise.resolve({ installed: true, path: p, version: 'managed' });
    return Promise.resolve({ installed: false, path: null, version: null });
  },
});

registerByokRoutes(apiRouter, {
  send,
  readJson,
  maskKey,
  providers,
  listActivatedProviderRecords,
  publicActivatedProviderRecord,
  publicImageAnalysisRuntime,
  pickActivatedCloudImageAnalysisRuntime,
  buildRuntimeRecommendations,
  fetchRelayModelIndex,
  normalizeRelayEndpointInput,
  buildRelayActivationRecords,
  setActivatedProviderRecord,
  getActivatedProviderRecord,
  deleteActivatedProviderRecord,
  hydrateActivatedProviderRecordsFromDisk,
  persistActivatedProviderRecordsToDisk,
  activatedProviders,
  broadcastCatalogUpdate,
  validateByokProvider,
  syncArkEndpoints,
  MODEL_CATALOG,
});

registerModelsRoutes(apiRouter, {
  send,
  // 对账状态经服务 getter 读取（服务内部可重赋值）。
  getCatalogReconcileState,
  reconcileModelCatalog,
  modelCatalogPayload,
});

registerAria2Routes(apiRouter, {
  send,
  readJson,
  getAria2Status: aria2Manager.getAria2Status,
  aria2AddUri: aria2Manager.aria2AddUri,
  aria2TellStatus: aria2Manager.aria2TellStatus,
  aria2TellActive: aria2Manager.aria2TellActive,
  aria2Remove: aria2Manager.aria2Remove,
  aria2VerifyHash: aria2Manager.aria2VerifyHash,
});

registerAssetsRoutes(apiRouter, {
  send,
  readJson,
  getUserFromRequest,
  // settings
  loadOperationDispatchConfig,
  saveOperationDispatchConfig,
  OPERATION_DISPATCH_CONFIG_FILE,
  readAssetLibrarySettings,
  writeAssetLibrarySettings,
  ASSET_LIBRARY_SETTINGS_FILE,
  ASSET_LIBRARY_CATALOG_FILE,
  DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
  pickLocalDirectory,
  // asset library
  readAssetLibraryCatalog,
  writeAssetLibraryCatalog,
  buildAssetLibraryDuplicateGroups,
  writeAssetLibraryDuplicates,
  readAssetLibraryDuplicates,
  deleteAssetLibraryItems,
  pruneMissingAssetLibraryItems,
  restoreAssetLibraryItems,
  findAssetLibraryItem,
  probeAssetMedia,
  repairAssetLibraryItem,
  buildAssetLibraryContentUrl,
  readAssetLibraryImportMultipart,
  processAssetLibraryImportRequest,
  processAssetLibraryImportDirectory,
  // content stream
  sanitizeLocalAssetId,
  sendLocalFileStream,
  mediaMimeTypeFromExtension,
  buildSafeInlineContentDisposition,
});

registerDccRoutes(apiRouter, {
  send,
  readJson,
  DCC_ENVIRONMENT_MANAGER,
  DCC_ENGINES,
  summarizeCurrentUnrealEnvironment,
  probeTcp,
  isUnrealDirectBridgeOnline,
  getUnrealDirectBridge,
  DCC_RECORDING_LOCK,
  ENABLE_UNREAL_PIXEL_STREAMING_LEGACY,
  DEFAULT_UNREAL_PIXEL_URL,
  DEFAULT_UNREAL_REMOTE_URL,
  UNREAL_PIXEL_STREAMING_LEGACY,
  getUnrealControlConfig,
  readUnrealConfig,
  writeUnrealConfig,
  getUserFromRequest,
  getValidTokenForOwner,
});

// ComfyUI 网关前缀组：整组早已收敛为 handleComfyUiApi，此处仅把分发点
// 从 route() 手写 if 迁入路由表（前缀命中在精确路径之后，无遮蔽风险）。
apiRouter.registerPrefix('*', '/api/comfyui/', handleComfyUiApi);

registerMediaRoutes(apiRouter, {
  execFileAsync,
  handleCuratorPreviewProxy,
  https,
  proxyHuggingFace,
  proxyRemoteMediaAsset,
  readJson,
  resolveLocalPostFfmpegBackend,
  resolveYtDlpPath,
  runCommand,
  send,
  serveLocalModel,
  serveTransformersModule,
});

registerCobuildRoutes(apiRouter, {
  crypto,
  getCobuildUserSafe,
  getUserFromRequest,
  maskEmailForDisplay,
  readCobuild,
  readJson,
  send,
  sendAuthError,
  writeCobuild,
});

registerSearchRoutes(apiRouter, {
  OPENVERSE_BASE,
  PEXELS_BASE,
  PIXABAY_BASE,
  UNSPLASH_BASE,
  WIKIMEDIA_BASE,
  hashString,
  http,
  https,
  polyhavenCatalogCache,
  readJson,
  send,
});

registerLocalAiRoutes(apiRouter, {
  LOCAL_AUDIO_RESULT_DIR,
  LOCAL_POST_RESULT_DIR,
  LOCAL_VIDEO_RESULT_DIR,
  buildSafeInlineContentDisposition,
  executeGenerationRequest,
  getDccLocalArtifact,
  mediaMimeTypeFromExtension,
  path,
  previewGenerationRequest,
  processLocalAudioGenerateRequest,
  processLocalImageAnalyzeRequest,
  processLocalPostRequest,
  processLocalVideoEditRequest,
  processRemoteAudioGenerateRequest,
  readJson,
  readLocalImageAnalyzeMultipart,
  readLocalPostMultipart,
  sanitizeLocalAssetId,
  send,
  sendLocalFileStream,
  getUserFromRequest,
});

registerNetdiskRoutes(apiRouter, { send, readJson });
registerNetdiskScrapeRoutes(apiRouter, { send, readJson });

registerAgentRoutes(apiRouter, {
  ASSET_LIBRARY_TEMP_DIR,
  collectFreeLlmCandidates,
  crypto,
  deleteMemory,
  extensionFromMimeType,
  formatSseEvent,
  fs,
  getMemory,
  nextFreeLlm,
  path,
  processAssetLibraryImportRequest,
  readJson,
  runAgentReasoning,
  sanitizeAssetFileBaseName,
  send,
  setAllMemory,
  setMemory,
  sendJson: send,
});

export { apiRouter };

const server = http.createServer(route);
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
  if (pathname === '/ws/workflow') {
    void handleWorkflowUpgrade(req, socket, head);
    return;
  }
  if (pathname === '/ws/catalog') {
    void handleCatalogUpgrade(req, socket, head);
    return;
  }
  void handleDccUpgrade(req, socket, head);
});

// ===== Runtime guards =====
process.on('uncaughtException', (error) => {
  console.error('[HMDao API] uncaught exception:', error.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[HMDao API] unhandled rejection:', reason);
});

// P3-9/P3-3：注入运行时路径与重依赖，使回滚/清理模块与真实清单、探测缓存联动。
configureRuntimeRollback({
  managedRuntimeDir: LOCAL_POST_MANAGED_RUNTIME_DIR,
  installableRuntimeKeys: Object.keys(LOCAL_POST_INSTALLABLE_RUNTIMES || {}),
  persistEntry: persistManagedRuntimeManifestEntry,
  clearCache: clearLocalPostRuntimeDetectionCache,
});

// P3-11：注入 job 状态更新函数，使全局串行安装队列能回写集中状态。
configureRuntimeInstallQueue({ updateRuntimeInstallJob });

// 单测隔离：设置 HMDAO_TEST_NO_SERVER 时仅导出函数、不启动监听，便于直接 import 测试纯逻辑。
if (!process.env.HMDAO_TEST_NO_SERVER) {
  // P3：启动时恢复持久化会话（重启不丢登录态，单实例下适用）。
  loadSessions();
  // P3：定期清理过期令牌，防止 sessions.json 无限增长。
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of accessSessions.entries()) if (!v || v.expiresAt <= now) accessSessions.delete(k);
    for (const [k, v] of sessions.entries()) if (!v || v.expiresAt <= now) sessions.delete(k);
  }, 10 * 60 * 1000);

  // 监听地址可配置：默认 127.0.0.1（本地），云端部署由 deploy/Caddyfile 反代，故保持 127.0.0.1 切勿改 0.0.0.0。
  const HOST = process.env.HMDAO_API_HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    console.log(`[HMDao API] http://${HOST}:${PORT}`);
    // 开机自动清理 catalog 中已丢失本地文件（被移动/删除）的 disk 型死引用，避免前端反复 404。
    void pruneMissingAssetLibraryItems()
      .then((r) => { if (r.removedCount) console.log(`[HMDao API] pruned ${r.removedCount} missing asset refs (catalog cleanup)`); })
      .catch((e) => console.error('[HMDao API] prune failed:', e.message));
    // 扩展采集链路零配置：启动后自动静默安装下载类运行时
    void bootstrapAutoInstallLocalPostRuntimes()
      .catch((e) => console.error('[HMDao API] auto-install bootstrap failed:', e.message));
  });
}

// ===== P2.b：面板 SmartAgent 后端 ReAct 流式规划端点（SSE）核心工具（模块级，便于单测与复用）=====
function formatSseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// 从模型文本稳健提取结构化计划 JSON（容错：去 markdown 围栏、截取首尾花括号）
function parseAgentPlan(content) {
  let s = String(content || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('响应中未找到 JSON 计划');
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { throw new Error('计划 JSON 解析失败'); }
  if (!obj || typeof obj !== 'object') throw new Error('计划不是有效对象');
  const validSkills = ['text', 'image', 'video', 'audio', 'script', 'storyboard'];
  const skillId = String(obj.skillId || '').trim().toLowerCase();
  if (!validSkills.includes(skillId)) throw new Error('skillId 无效：' + skillId);
  const steps = Array.isArray(obj.suggestedSteps)
    ? obj.suggestedSteps
      .filter((x) => x && typeof x === 'object' && typeof x.type === 'string')
      .map((x) => ({ type: String(x.type).trim(), label: String(x.label || '').slice(0, 200), prompt: String(x.prompt || '').slice(0, 4000) }))
    : [];
  return {
    skillId,
    skillName: String(obj.skillName || skillId).slice(0, 80),
    confidence: typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.6,
    extractedParams: obj.extractedParams && typeof obj.extractedParams === 'object' ? obj.extractedParams : {},
    suggestedSteps: steps.length
      ? steps
      : [{ type: skillId, label: obj.skillName || skillId, prompt: (obj.extractedParams && obj.extractedParams.prompt) || '' }],
  };
}

// ReAct 推理核心：构建 system+history+user(画布状态+记忆) -> 调用 AI -> 解析 thinking + 计划
async function runAgentReasoning({ text, history = [], canvasSummary = '', scope = 'global' }) {
  const fallbackKey = process.env.HMDAO_AI_KEY || 'sk-dAViKE9mAm0RqXdfc8nFYn4xAYyOlMjp0l0LcfnmgYdfUcni';
  const fallbackUrl = process.env.HMDAO_AI_URL || 'https://tokenhub.tencentmaas.com/v1/chat/completions';
  const fallbackModel = process.env.HMDAO_AI_MODEL || 'hy3';
  // 轮换：优先用 nextFreeLlm 选中的那个免费模型，失败再依次回退其余候选
  const chatPool = collectFreeLlmCandidates('chat');
  const chatStart = nextFreeLlm('chat');
  const chatOrdered = chatStart
    ? [chatStart, ...chatPool.filter((c) => `${c.provider}/${c.model}` !== `${chatStart.provider}/${chatStart.model}`)]
    : [{ provider: 'tokenhub', model: fallbackModel, endpoint: fallbackUrl, apiKey: fallbackKey }];
  const memCtx = memoryContextString(scope);
  const system = `你是 Ddayup 画布智能体（ReAct 工作流规划器）。根据用户自然语言目标，规划一个画布工作流。
可用技能 skillId（六选一）：text(文本/文案/代码)、image(文生图/图生图)、video(文生视频/图生视频)、audio(语音/音乐/音效)、script(脚本/代码)、storyboard(分镜/多镜头)。
请先内部推理（reasoning_content），再只输出一个严格 JSON 对象（不要 markdown 代码块、不要额外解释）：
{
  "skillId": "image",
  "skillName": "文生图",
  "confidence": 0.9,
  "extractedParams": { "prompt": "核心提示词", "style": "风格", "negativePrompt": "不想要的元素" },
  "suggestedSteps": [ { "type": "image", "label": "步骤说明", "prompt": "该步骤提示词" } ]
}
约束：skillId 必须是六者之一；suggestedSteps 至少 1 项且 type 同属六者；用户目标模糊时选最可能技能并给合理默认。${
    memCtx ? `\n\n【用户长期记忆（优先遵循，保持人设与品牌一致性）】\n${memCtx}` : ''
  }`;
  const userContent = (canvasSummary ? `当前画布状态：${canvasSummary}\n` : '') + `用户目标：${text}`;
  let data = null;
  let lastError = null;
  let usedModel = null;
  for (const cand of chatOrdered) {
    const apiKey = String(cand.apiKey || fallbackKey).trim();
    const apiUrl = String(cand.endpoint || fallbackUrl).trim();
    const model = String(cand.model || fallbackModel).trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: userContent },
          ],
          temperature: 0.5,
          max_tokens: 1500,
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        throw new Error(`AI 服务错误 ${r.status}: ${errText.slice(0, 200)}`);
      }
      data = await r.json().catch(() => ({}));
      usedModel = `${cand.provider || 'tokenhub'}/${model}`;
      break;
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!data) throw lastError || new Error('所有免费聊天模型均不可用');
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  const content = message && typeof message.content === 'string' ? message.content : '';
  const thinking = message && typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
  if (!content) throw new Error('AI 返回空内容');
  const plan = parseAgentPlan(content);
  const summary = `已为你规划「${plan.skillName}」工作流，共 ${plan.suggestedSteps.length} 步。`;
  return { thinking, text: summary, plan, usedModel };
}

export {
  replaceDirectoryContents,
  pruneOldBakBackups,
  listManagedLocalPostBackups,
  rollbackManagedLocalPostRuntime,
  cleanupManagedLocalPostRuntimeTemp,
  LOCAL_POST_MANAGED_RUNTIME_DIR,
  resolveLlmOperationDispatch,
  resolveImageOperationDispatch,
  resolveVideoOperationDispatch,
  MODEL_CATALOG,
  loadOperationDispatchConfig,
  inlineCloudConditioningMedia,
  isLocalOnlyMediaReference,
  runAgentReasoning,
  parseAgentPlan,
  formatSseEvent,
  isVisionModelId,
  resolveImageAnalysisRuntime,
  hydrateActivatedProviderRecordsFromDisk,
  ACTIVATED_PROVIDERS_FILE,
  refineLocalAnalysisWithFreeLlm,
};

// P1-10：以下 52 个 local-post 处理/检测函数已抽取至 lib/local-post-processing.mjs。
import {
  applyManagedFlorence2Env,
  buildParseSummary,
  clampNumber,
  clearLocalPostRuntimeDetectionCache,
  detectLocalPostGmicPath,
  detectLocalPostOcioRuntimePath,
  detectLocalPostOiioConfigPath,
  detectLocalPostOiioPath,
  detectManagedLocalPostFlorence2Path,
  detectManagedLocalPostFlorence2Python,
  detectManagedLocalPostOcioPath,
  detectManagedLocalPostYtDlpPath,
  detectManagedLocalPostAria2Path,
  detectManagedLocalPostFfmpegPath,
  detectSceneCuts,
  extractZipArchiveToDirectory,
  findFileRecursively,
  getLatestRuntimeInstallJob,
  getManagedRuntimeManifestEntry,
  getRuntimeInstallJob,
  inspectOcioConfigFile,
  isPathInsideDir,
  isSupportedBokehFile,
  isSupportedLutFile,
  isSupportedOcioConfigFile,
  persistManagedRuntimeManifestEntry,
  postTempPath,
  removeManagedRuntimeManifestEntry,
  replaceDirectoryContents,
  resolveLocalPostFlorence2Backend,
  resolveLocalPostWrapperCommand,
  resolveLocalPostYtDlpBackend,
  resolvePostUpscaleRoute,
  buildLocalPostBackendStatus,
  resolveLocalPostUpscaleBackend,
  resolveLocalPostOcioBackend,
  resolveLocalPostOiioBackend,
  resolveLocalPostGmicBackend,
  resolveLocalPostAria2Backend,
  resolveLocalPostFfmpegBackend,
  runCommand,
  toRuntimeInstallJobResponse,
  updateRuntimeInstallJob,
} from './lib/local-post-processing.mjs';
