import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { clearProgress, getAllDownloadProgress, loadModel, type ModelDownloadProgress } from '@/services/modelLoader';
import { PRESET_MODELS, SEARCH_EXTENSIONS, type PresetModel } from '@/config/presetModels';
import { EXTENSION_STORE_URL } from '@/config/extensionStore';
import { SHOW_DEV_INSTALL } from '@/config/environment';
import {
  checkPresetUpdates,
  clearPresetInstalled,
  getPresetInstallHealth,
  getPresetUpdateInfo,
  initPresetInstalledState,
  markPresetInstalled,
  subscribePresetInstall,
} from '@/services/presetModelInstall';
import { hasLocalModelRunner } from '@/services/localModelRunner';
import { deleteCachedModel } from '@/services/storage';
import {
  activateLocalModel,
  deactivateLocalModel,
  reactivateInstalledLocalModels,
} from '@/services/localInference';
import {
  ensureTranslatorLoaded,
  getLocalTranslateState,
  onLocalTranslateStateChange,
  clearNllbCacheAndRetry,
} from '@/services/localTranslate';
import { comfyConfig, comfyHealth, runComfyChain, startComfyUi, openComfyUiWeb, installComfyUiManager, type ComfyConfig, type ComfyUiHealth } from '@/services/comfyui/comfyuiClient';
import { detectHmdaoExtension, fetchHmdaoExtBuilds, type HmdaoBuilds } from '@/services/extensionBridge';
import { pickAssetLibraryDirectory } from '@/api/assetLibrary';

type RuntimeBackendStatus = {
  configured: boolean;
  commandConfigured: boolean;
  detectedPath: string;
  detectedConfigPath?: string;
  wrapperScript: string;
  exampleRuntimePath: string;
  runtimeName?: string;
  envPath?: string;
  envCommand?: string;
  docsUrl?: string;
  downloadUrl?: string;
  installHint?: string;
  successHint?: string;
  commonInstallPaths?: string[];
  supportsImage?: boolean;
  supportsVideo?: boolean;
};

type RuntimeUpdateStatus = {
  supported: boolean;
  checkedAt: string;
  sourceLabel: string;
  releaseUrl: string;
  latestVersion: string;
  installedVersion: string;
  updateAvailable: boolean;
  status: 'error' | 'unknown' | 'latest-known' | 'up-to-date' | 'update-available';
  summary: string;
  error: string;
};

type RuntimeDoctorRuntime = {
  runtimeKey: string;
  runtimeName: string;
  status: 'ok' | 'warn' | 'error';
  summary: string;
  detectedPath?: string;
  detectedConfigPath?: string;
  executableVerified?: boolean;
  installedVersion?: string;
  checkedCommand?: string[];
  stdout?: string;
  stderr?: string;
  elapsedMs?: number;
  configVerified?: boolean;
  configSummary?: string;
  suggestions?: string[];
  update?: RuntimeUpdateStatus;
};

type RuntimeDoctorReport = {
  checkedAt: string;
  runtimes: {
    ocio?: RuntimeDoctorRuntime;
    oiio?: RuntimeDoctorRuntime;
    gmic?: RuntimeDoctorRuntime;
    ytdlp?: RuntimeDoctorRuntime;
    florence2?: RuntimeDoctorRuntime;
    aria2?: RuntimeDoctorRuntime;
    ffmpeg?: RuntimeDoctorRuntime;
  };
};

type RuntimePayload = {
  capabilities?: {
    localPostBackends?: {
      ocio?: RuntimeBackendStatus;
      oiio?: RuntimeBackendStatus;
      gmic?: RuntimeBackendStatus;
      ytdlp?: RuntimeBackendStatus;
      florence2?: RuntimeBackendStatus;
      aria2?: RuntimeBackendStatus;
      ffmpeg?: RuntimeBackendStatus;
    };
  };
} | null;

type RuntimeInstallJob = {
  id: string;
  runtimeKey: string;
  runtimeName: string;
  requestedAction: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  stage: string;
  progress: number;
  message: string;
  error: string;
  targetVersion: string;
  installedVersion: string;
  sourceLabel: string;
  downloadUrl: string;
  releaseUrl: string;
  startedAt: number;
  updatedAt: number;
  completedAt: number;
  verified: boolean;
  doctor?: RuntimeDoctorRuntime | null;
};

interface RuntimeCardItem {
  id: 'oiio' | 'gmic' | 'ocio' | 'ytdlp' | 'florence2' | 'aria2' | 'ffmpeg';
  title: string;
  scope: string;
  /** 备注：该依赖的功能用途 */
  purpose: string;
  /** 备注：该依赖所属/服务的来源节点 */
  sourceNode: string;
  status: RuntimeBackendStatus | null;
  doctor?: RuntimeDoctorRuntime;
  job?: RuntimeInstallJob | null;
}

/**
 * 运行时安装接口的身份（2026-09-16 服务端收紧为「已授权设备 / 运维 Key」才可调用）。
 * 官网侧优先取 URL query（与 PricingPage 的 ?deviceId=&token= 同源约定），
 * 其次读 localStorage（供扩展同步登录后写入的场景）；本机直连由服务端回环放行，不依赖此值。
 */
function readRuntimeAuth(): { deviceId: string; token: string } {
  try {
    const sp = new URLSearchParams(window.location.search);
    const deviceId = (sp.get('deviceId') || '').trim();
    const token = (sp.get('token') || '').trim();
    if (deviceId) return { deviceId, token };
    return {
      deviceId: (window.localStorage.getItem('hmdaoDeviceId') || '').trim(),
      token: (window.localStorage.getItem('hmdaoToken') || '').trim(),
    };
  } catch {
    return { deviceId: '', token: '' };
  }
}

const INSTALL_AUTH_HINT_401 = '缺少设备标识：请从浏览器扩展内进入本页，或先在扩展内登录 / 开启试用。';
const INSTALL_AUTH_HINT_402 = '当前设备未授权（试用已到期或未开通）：请订阅后重试运行时安装。';

// PRESET_MODELS 与 SEARCH_EXTENSIONS 现统一定义于 @/config/presetModels，便于全局引用与扩展。

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, index)).toFixed(1)} ${units[index]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

// P0-1: 插件管理三分区容器（带状态摘要徽标）
type PluginZoneProps = {
  title: string;
  subtitle?: string;
  accent?: 'blue' | 'green' | 'purple';
  summary?: string;
  children: ReactNode;
};

function PluginZone({ title, subtitle, accent = 'blue', summary, children }: PluginZoneProps) {
  const accentRing =
    accent === 'green' ? 'ring-[#00d4aa]/20' : accent === 'purple' ? 'ring-[#a371f7]/20' : 'ring-[#1a8cff]/20';
  const accentText =
    accent === 'green' ? 'text-[#9bf5df]' : accent === 'purple' ? 'text-[#d2b3ff]' : 'text-[#7cc4ff]';
  const dot = accent === 'green' ? 'bg-[#00d4aa]' : accent === 'purple' ? 'bg-[#a371f7]' : 'bg-[#1a8cff]';
  return (
    <section data-testid={`plugin-zone-${title}`} className={`rounded-2xl bg-[#0d1117] p-3 ring-1 ${accentRing}`}>
      <div className="mb-3 flex items-center gap-2 border-b border-[#21262d] pb-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <h4 className={`text-xs font-semibold ${accentText}`}>{title}</h4>
        {subtitle ? <span className="text-[9px] text-[#6e7681]">{subtitle}</span> : null}
        {summary ? (
          <span className="ml-auto rounded-full bg-white/8 px-2 py-0.5 text-[9px] text-[#9aa4af]">{summary}</span>
        ) : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// 从下载进度里累加「主文件 + 外部权重」的真实字节，给面板一个可信的聚合大小。
function aggregateProgressBytes(p?: ModelDownloadProgress): { downloaded: number; total: number } {
  if (!p) return { downloaded: 0, total: 0 };
  let downloaded = p.downloadedBytes;
  let total = p.totalBytes;
  for (const ef of p.extraFiles || []) {
    downloaded += ef.downloaded;
    total += ef.total;
  }
  return { downloaded, total };
}

function runtimeCapabilityLabel(status: RuntimeBackendStatus | null): string {
  if (!status) return '等待后端返回能力信息';
  const supportsImage = status.supportsImage !== false;
  const supportsVideo = status.supportsVideo === true;
  if (supportsImage && supportsVideo) return '支持图片 / 视频';
  if (supportsImage) return '仅支持图片';
  if (supportsVideo) return '仅支持视频';
  return '能力未声明';
}

function commonInstallPathLabel(status: RuntimeBackendStatus | null): string {
  const paths = Array.isArray(status?.commonInstallPaths) ? status.commonInstallPaths.filter(Boolean).slice(0, 3) : [];
  return paths.length ? paths.join(' / ') : '暂无常见安装路径';
}

function runtimeBadge(configured: boolean, detected: boolean) {
  if (configured) {
    return {
      className: 'bg-[#00d4aa]/12 text-[#9bf5df]',
      label: '已接入',
    };
  }
  if (detected) {
    return {
      className: 'bg-[#f59e0b]/12 text-[#fbd38d]',
      label: '已发现待校验',
    };
  }
  return {
    className: 'bg-[#1a8cff]/12 text-[#7cc4ff]',
    label: '未安装 / 未识别',
  };
}

function doctorBadge(status: RuntimeDoctorRuntime['status'] | undefined) {
  // 仅在用户主动自检（或安装完成后自动自检）后才会有结果：
  //   ok   → 自检通过
  //   warn → 需补完整链路
  //   其它（未安装/校验未通过）→ 显示「未安装」，不再用刺眼的「自检失败」
  // 未自检（status 为空）→ 返回 null，徽标整体不渲染
  if (status === 'ok') return { className: 'bg-[#00d4aa]/12 text-[#9bf5df]', label: '自检通过' };
  if (status === 'warn') return { className: 'bg-[#f59e0b]/12 text-[#fbd38d]', label: '需补完整链路' };
  if (status) return { className: 'bg-[#1a8cff]/12 text-[#7cc4ff]', label: '未安装' };
  return null;
}

function updateBadge(update: RuntimeUpdateStatus | undefined) {
  if (!update?.supported) return { className: 'bg-white/8 text-[#9aa4af]', label: '暂不支持更新检查' };
  if (update.updateAvailable) return { className: 'bg-[#f59e0b]/12 text-[#fbd38d]', label: '有更新' };
  if (update.status === 'up-to-date') return { className: 'bg-[#00d4aa]/12 text-[#9bf5df]', label: '已是最新' };
  if (update.status === 'latest-known') return { className: 'bg-[#1a8cff]/12 text-[#7cc4ff]', label: '已知最新版本' };
  if (update.status === 'error') return { className: 'bg-[#f85149]/12 text-[#ffb4b4]', label: '更新检查失败' };
  return { className: 'bg-white/8 text-[#9aa4af]', label: '更新未知' };
}

function installBadge(job: RuntimeInstallJob | null | undefined, doctor: RuntimeDoctorRuntime | undefined) {
  if (!job) return null;
  if (job.status === 'failed' && doctor?.status === 'ok') return null;
  if (job.status === 'succeeded') return { className: 'bg-[#00d4aa]/12 text-[#9bf5df]', label: '安装完成' };
  if (job.status === 'failed') return { className: 'bg-[#f85149]/12 text-[#ffb4b4]', label: '安装失败' };
  return { className: 'bg-[#1a8cff]/12 text-[#7cc4ff]', label: '安装中' };
}

function updateSummary(doctor: RuntimeDoctorRuntime | undefined) {
  if (!doctor?.update) return '暂未接入更新检查';
  return doctor.update.summary || '暂未获取到更新信息';
}

function installedVersionSummary(doctor: RuntimeDoctorRuntime | undefined, job: RuntimeInstallJob | null | undefined) {
  if (doctor?.installedVersion) return `本机版本 ${doctor.installedVersion}`;
  if (job?.installedVersion) return `已安装版本 ${job.installedVersion}`;
  return '本机尚未检测到已安装版本';
}

function isRuntimeJobActive(job: RuntimeInstallJob | null | undefined) {
  return job?.status === 'pending' || job?.status === 'running';
}

function runtimeActionLabel(runtime: RuntimeCardItem) {
  if (isRuntimeJobActive(runtime.job)) {
    return runtime.job?.progress ? `安装中 ${runtime.job.progress}%` : '安装中';
  }
  if (runtime.doctor?.update?.updateAvailable) return '更新到最新版';
  if (runtime.doctor?.installedVersion || runtime.status?.detectedPath) return '重新安装';
  return '一键安装';
}

/** NLLB-200 翻译卡片：数据源为单一注册表 PRESET_MODELS（browserRuntime:'nllb'），
 *  实时下载/就绪状态来自 localTranslate 的加载器状态机（父组件已订阅 forceTranslateTick 触发重渲染）。 */
function NllbModelCard({ model }: { model: PresetModel }) {
  // 自订阅翻译加载状态：状态变化时本卡片独立重渲染，不依赖父面板的 forceTranslateTick
  const [, forceCardTick] = useState(0);
  useEffect(() => {
    const unsub = onLocalTranslateStateChange(() => forceCardTick((tick) => tick + 1));
    return () => unsub();
  }, []);
  const state = getLocalTranslateState();
  const downloading = state.status === 'downloading';
  const ready = state.status === 'ready';
  const hasError = state.status === 'error';
  const progress = Math.round(state.progress);
  const statusLabel = ready
    ? '已安装 · 可用'
    : hasError
      ? '安装失败'
      : downloading
        ? `下载中 ${progress}%`
        : '未安装';
  const statusClass = ready
    ? 'text-[#00d4aa]'
    : hasError
      ? 'text-[#f85149]'
      : downloading
        ? 'text-[#1a8cff]'
        : 'text-[#6e7681]';
  return (
    <details className="group rounded-xl bg-[#161b22] ring-1 ring-[#21262d]" data-testid={`browser-model-${model.id}`}>
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3 marker:content-none">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${ready ? 'bg-[#00d4aa]/15' : hasError ? 'bg-[#f85149]/15' : 'bg-[#1a8cff]/15'}`}>
          {ready ? (
            <CheckCircle2 className="h-4 w-4 text-[#00d4aa]" />
          ) : hasError ? (
            <AlertCircle className="h-4 w-4 text-[#f85149]" />
          ) : downloading ? (
            <Loader2 className="h-3 w-3 animate-spin text-[#1a8cff]" />
          ) : (
            <Download className="h-4 w-4 text-[#1a8cff]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-[#c9d1d9]">{model.name}</p>
            <span className={`rounded-full bg-white/8 px-2 py-0.5 text-[9px] ${statusClass}`}>{statusLabel}</span>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-[#6e7681]">{model.purpose || model.desc}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {ready ? (
            <span className="rounded-lg bg-[#00d4aa]/12 px-2.5 py-1 text-[10px] font-medium text-[#9bf5df]">已就绪</span>
          ) : (
            <button
              type="button"
              disabled={downloading}
              onClick={() => void ensureTranslatorLoaded()}
              className={`rounded-lg px-2.5 py-1 text-[10px] font-medium transition-colors ${
                downloading
                  ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
                  : 'bg-[#1a8cff]/15 text-[#1a8cff] hover:bg-[#1a8cff]/25'
              }`}
            >
              {downloading ? '下载中' : hasError ? '重试' : '一键安装'}
            </button>
          )}
          {hasError && (
            <button
              type="button"
              disabled={downloading}
              onClick={() => void clearNllbCacheAndRetry()}
              className="rounded-lg px-2.5 py-1 text-[10px] font-medium text-[#d29922] bg-[#d29922]/15 transition-colors hover:bg-[#d29922]/25"
              title="清除浏览器模型缓存（应对缓存损坏 / 镜像慢导致的安装失败）后重新下载"
            >
              清除缓存并重试
            </button>
          )}
        </div>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#6e7681] transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-[#21262d] px-3 pb-3 pt-2">
        <p className="text-[10px] text-[#6e7681]">{model.desc}</p>
        <p className="mt-1 text-[10px] text-[#8b949e]">
          备注：{model.purpose || '本地翻译推理'} · 来源节点：{model.node || '翻译'}
        </p>
        <div className="mt-1 flex items-center gap-2 text-[9px] text-[#6e7681]">
          <span>{model.size}</span>
          <span>来源：Hugging Face Hub</span>
        </div>
        {hasError && state.error ? (
          <p className="mt-1 text-[10px] text-[#f85149]">{state.error}</p>
        ) : null}
        {downloading ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#21262d]">
            <div
              className="h-full rounded-full bg-[#1a8cff] transition-all duration-300"
              style={{ width: `${Math.max(progress, 5)}%` }}
            />
          </div>
        ) : null}
      </div>
    </details>
  );
}

// 内置最小可运行 ComfyUI 工作流（本地推理，无需云端密钥），供"测试链路"一键验证。
const MINIMAL_WORKFLOW = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 0, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.ckpt' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a beautiful mountain landscape at sunset', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark, blurry', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'hmdao_test' } },
};

/**
 * ComfyUI 运行引擎卡片：
 * - 检测是否已安装/启动 ComfyUI（通过网关 /health 的实例可达性）。
 * - 未检测到时，面板内置安装指引（下载、一键脚本、启动、重新检测）。
 * - 已接入时，提供"测试链路"按钮，提交最小工作流并实时展示进度与成片，验证端到端可用。
 */
function ComfyEngineCard() {
  const [health, setHealth] = useState<ComfyUiHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [config, setConfig] = useState<ComfyConfig | null>(null);
  const [clientKeysText, setClientKeysText] = useState('');
  const [comfyInstanceUrl, setComfyInstanceUrl] = useState<string>(
    () => localStorage.getItem('hmdao.comfyInstanceUrl') || '',
  );
  const [chain, setChain] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    percent: number;
    node: string | null;
    error: string | null;
    outputs: Array<{ type?: string; url: string }>;
  }>({ state: 'idle', percent: 0, node: null, error: null, outputs: [] });
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const h = await comfyHealth();
      setHealth(h);
      // 同时拉取网关下发的可配置项（ALLOW_CLIENT_KEYS / MARKERS / 传输安全状态）。
      const c = await comfyConfig();
      setConfig(c);
    } catch {
      setHealth({ success: false, configured: false, reachable: false, gatewayUrl: null, detail: '请求失败' });
    } finally {
      setChecking(false);
    }
  }, []);

  // ComfyUI 集成处于「待完善」状态：已移除自动检测与自动配置逻辑，
  // 仅当用户点击「手动检测」时才请求一次 health/config。

  useEffect(() => {
    localStorage.setItem('hmdao.comfyInstanceUrl', comfyInstanceUrl);
  }, [comfyInstanceUrl]);

  // 运维：重启 ComfyUI / checkpoint 直接落盘 / 自定义运行时安装目录
  const [comfyRestarting, setComfyRestarting] = useState(false);
  const [checkpointUrl, setCheckpointUrl] = useState('');
  const [checkpointSubdir, setCheckpointSubdir] = useState('checkpoints');
  const [checkpointMsg, setCheckpointMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleRestartComfy = useCallback(async () => {
    setComfyRestarting(true);
    try {
      const r = await fetch('/api/comfyui/restart', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j?.success) {
        // 轮询 health 直到 ComfyUI 重新可达
        for (let i = 0; i < 60; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          const hr = await fetch('/api/comfyui/health').then((x) => x.json()).catch(() => null);
          if (hr?.reachable) break;
        }
      }
    } finally {
      setComfyRestarting(false);
      void refresh();
    }
  }, [refresh]);

  const [comfyStarting, setComfyStarting] = useState(false);
  const handleStartComfy = useCallback(async () => {
    setComfyStarting(true);
    try {
      const r = await startComfyUi();
      if (r?.launched) {
        // 轮询 health 直到 ComfyUI 启动可达
        for (let i = 0; i < 40; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          const hr = await fetch('/api/comfyui/health').then((x) => x.json()).catch(() => null);
          if (hr?.reachable) break;
        }
      } else if (r?.alreadyRunning) {
        openComfyUiWeb();
      } else if (r?.needsInstall && r.installUrl) {
        window.open(r.installUrl, '_blank', 'noopener');
      }
    } finally {
      setComfyStarting(false);
      void refresh();
    }
  }, [refresh]);

  const [managerInstalling, setManagerInstalling] = useState(false);
  const [managerMsg, setManagerMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handleInstallManager = useCallback(async () => {
    setManagerInstalling(true);
    setManagerMsg(null);
    try {
      const r = await installComfyUiManager();
      if (r?.success) {
        setManagerMsg({ ok: true, text: r.hint || 'ComfyUI-Manager 已安装，请重启 ComfyUI。' });
      } else if (r?.manualSteps) {
        setManagerMsg({ ok: false, text: r.hint || '请按手动步骤安装 ComfyUI-Manager。' });
      } else if (r?.alreadyInstalled) {
        setManagerMsg({ ok: true, text: r.hint || 'ComfyUI-Manager 已存在，重启 ComfyUI 即可。' });
      } else {
        setManagerMsg({ ok: false, text: `安装失败：${r?.error || r?.hint || '未知错误'}` });
      }
    } catch (e) {
      setManagerMsg({ ok: false, text: `请求异常：${e instanceof Error ? e.message : e}` });
    } finally {
      setManagerInstalling(false);
      void refresh();
    }
  }, [refresh]);

  const handleCheckpointDownload = useCallback(async () => {
    setCheckpointMsg(null);
    const url = checkpointUrl.trim();
    if (!url) {
      setCheckpointMsg({ ok: false, text: '请填写模型下载地址' });
      return;
    }
    try {
      const r = await fetch('/api/comfyui/checkpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, subdir: checkpointSubdir.trim() || 'checkpoints' }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.success) {
        setCheckpointMsg({ ok: true, text: `已落盘：${j.path}（${j.bytes} 字节）` });
      } else {
        setCheckpointMsg({ ok: false, text: `失败：${j?.error || r.status}` });
      }
    } catch (e) {
      setCheckpointMsg({ ok: false, text: `请求异常：${e instanceof Error ? e.message : e}` });
    }
  }, [checkpointUrl, checkpointSubdir]);

  const reachable = Boolean(health?.reachable);
  const guidance = health?.guidance || {
    defaultPort: '8188',
    downloadUrl: 'https://github.com/comfyanonymous/ComfyUI',
    docsUrl: 'https://docs.comfy.org',
    installHint: '在本地安装并启动 ComfyUI（默认监听 8188）后，本网关会自动接入。',
    installScript: 'install-comfyui.ps1（Windows）/ install-comfyui.sh（Linux/macOS）',
  };

  const runTestChain = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    let providerKeys: Record<string, string> | undefined;
    if (clientKeysText.trim()) {
      try {
        providerKeys = JSON.parse(clientKeysText) as Record<string, string>;
      } catch {
        // 忽略非法 JSON，回退到服务端统一密钥
      }
    }
    const wf: any = JSON.parse(JSON.stringify(MINIMAL_WORKFLOW));
    // 随机种子：避免 ComfyUI 对完全相同的图做缓存而导致 history 无 outputs。
    wf['3'].inputs.seed = Math.floor(Math.random() * 1e9);
    setChain({ state: 'running', percent: 0, node: null, error: null, outputs: [] });
    try {
      const final = await runComfyChain(wf, {
        signal: ac.signal,
        providerKeys,
        instance: comfyInstanceUrl.trim() || undefined,
        onProgress: (st) => setChain((c) => ({ ...c, percent: st.progress?.percent ?? 0, node: st.current_node })),
      });
      if (final.status === 'done') {
        setChain({
          state: 'done',
          percent: 100,
          node: null,
          error: null,
          outputs: (final.outputs || []).map((o) => ({ type: o.type, url: o.url })),
        });
      } else {
        setChain({ state: 'error', percent: 0, node: null, error: final.error || '执行失败', outputs: [] });
      }
    } catch (e) {
      setChain({ state: 'error', percent: 0, node: null, error: e instanceof Error ? e.message : String(e), outputs: [] });
    }
  }, []);

  return (
    <div className="rounded-xl bg-[#161b22] p-3 ring-1 ring-[#21262d]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${reachable ? 'bg-[#00d4aa]' : checking ? 'bg-[#1a8cff] animate-pulse' : 'bg-[#8b949e]'}`} />
          <span className="text-xs font-semibold text-[#e6edf3]">ComfyUI 运行引擎</span>
          <span className="rounded bg-[#f59e0b]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#f59e0b]">待完善</span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          className="inline-flex items-center gap-1 rounded-lg border border-[#2d3236] bg-[#121518] px-2 py-0.5 text-[10px] text-[#c9d1d9] transition hover:border-[#46515d] disabled:opacity-60"
        >
          <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
          手动检测
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-[#8b949e]">
        备注：本地工作流运行引擎（服务 ComfyUI 工作流节点）。该集成尚在完善中，已停用自动检测与自动配置；需要时可点「手动检测」。
      </p>

      {reachable ? (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-[#00d4aa]">已接入 ComfyUI 运行引擎，可直接生成。</p>
          {(health?.instances || []).filter((i) => i.reachable).map((i) => (
            <p key={i.id} className="font-mono text-[10px] text-[#6e7681]">实例 {i.id}: {i.url}</p>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openComfyUiWeb()}
              className="inline-flex items-center gap-1 rounded-lg border border-[#7a4b2a] bg-[#2a1c10] px-2.5 py-1 text-[10px] text-[#ffcf9e] transition hover:border-[#a8622f] hover:bg-[#332312]"
            >
              打开 ComfyUI
            </button>
            <p className="text-[9px] text-[#6e7681]">在 ComfyUI 网页中点击 <span className="text-[#e6edf3]">Manager</span> 按钮即可安装/管理自定义节点插件（ComfyUI-Manager）。</p>
          </div>

          <details className="group rounded-lg bg-[#0f1317] p-2 ring-1 ring-[#21262d]">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] text-[#c9d1d9] marker:content-none">
              <span>网关可配置项</span>
              <ChevronDown className="h-3 w-3 text-[#8b949e] transition group-open:rotate-180" />
            </summary>
            <div className="mt-2 space-y-1.5 text-[10px] text-[#9aa4af]">
              <div>
                允许客户端密钥 (ALLOW_CLIENT_KEYS)：
                <span className={config?.allowClientKeys ? 'text-[#00d4aa]' : 'text-[#f59e0b]'}>
                  {config?.allowClientKeys ? ' 是' : ' 否'}
                </span>
              </div>
              <div>
                传输安全 (HTTPS/TLS)：
                <span className={config?.tls ? 'text-[#00d4aa]' : 'text-[#f59e0b]'}>
                  {config?.tls ? ' 已启用' : ' 未启用（本地明文）'}
                </span>
            </div>
              <div className="mt-1">
                <p>自定义 ComfyUI 实例地址（留空则用网关默认）：</p>
                <input
                  value={comfyInstanceUrl}
                  onChange={(e) => setComfyInstanceUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8188"
                  className="mt-1 w-full rounded bg-[#161b22] p-1.5 font-mono text-[9px] text-[#c9d1d9] ring-1 ring-[#21262d] outline-none focus:ring-[#1a8cff]"
                />
                <p className="text-[9px] text-[#6e7681]">指定用 -TargetDir 安装到其它目录/端口的 ComfyUI 时，填其地址即可直接选用。</p>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleRestartComfy()}
                  disabled={comfyRestarting}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#7a4b2a] bg-[#2a1c10] px-2.5 py-1 text-[10px] text-[#ffcf9e] transition hover:border-[#a8622f] hover:bg-[#332312] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {comfyRestarting ? '重启中…' : '重启 ComfyUI'}
                </button>
                <p className="text-[9px] text-[#6e7681]">安装自定义节点后点此重启，新节点才会被加载。</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleInstallManager()}
                  disabled={managerInstalling}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#7a4b2a]/15 px-2.5 py-1 text-[10px] font-medium text-[#ffcf9e] transition hover:bg-[#7a4b2a]/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {managerInstalling ? '安装中…' : '安装 ComfyUI-Manager'}
                </button>
                <p className="text-[9px] text-[#6e7681]">ComfyUI-Manager 是独立的自定义节点，未安装时网页里<strong className="text-[#e6edf3]">没有 Manager 按钮</strong>；装好并重启 ComfyUI 后才会出现在顶部菜单。</p>
              </div>
              {managerMsg ? (
                <p className={`text-[9px] ${managerMsg.ok ? 'text-[#00d4aa]' : 'text-[#ffb4b4]'}`}>{managerMsg.text}</p>
              ) : null}
              <div className="mt-2 rounded-xl border border-[#2a2f35] bg-[#0f1317] px-3 py-2">
                <p className="text-[10px] font-medium text-[#e6edf3]">将模型直接下载到 ComfyUI</p>
                <p className="mt-1 text-[9px] text-[#6e7681]">填模型文件直链，服务端会把它落盘到 ComfyUI 的 models/&lt;子目录&gt;（默认 checkpoints），无需经过浏览器。</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    value={checkpointUrl}
                    onChange={(e) => setCheckpointUrl(e.target.value)}
                    placeholder="https://.../model.safetensors"
                    className="min-w-[200px] flex-1 rounded bg-[#161b22] p-1.5 font-mono text-[9px] text-[#c9d1d9] ring-1 ring-[#21262d] outline-none focus:ring-[#1a8cff]"
                  />
                  <input
                    value={checkpointSubdir}
                    onChange={(e) => setCheckpointSubdir(e.target.value)}
                    placeholder="checkpoints"
                    className="w-28 rounded bg-[#161b22] p-1.5 font-mono text-[9px] text-[#c9d1d9] ring-1 ring-[#21262d] outline-none focus:ring-[#1a8cff]"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCheckpointDownload()}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#1a8cff]/15 px-2.5 py-1 text-[10px] text-[#7cc4ff] transition hover:bg-[#1a8cff]/25"
                  >
                    下载落盘
                  </button>
                </div>
                {checkpointMsg ? (
                  <p className={`mt-1 text-[9px] ${checkpointMsg.ok ? 'text-[#00d4aa]' : 'text-[#ffb4b4]'}`}>{checkpointMsg.text}</p>
                ) : null}
              </div>
              {config?.markers?.length ? (
                <div>
                  支持的云端节点标记（MARKERS）：
                  <div className="mt-1 flex flex-wrap gap-1">
                    {config.markers.map((m) => (
                      <span
                        key={m.marker}
                        className="rounded bg-[#161b22] px-1.5 py-0.5 font-mono text-[9px] text-[#7cc4ff] ring-1 ring-[#21262d]"
                        title={`节点 class_type 含 "${m.marker}" 时，注入 ${m.provider} 密钥`}
                      >
                        {m.marker}→{m.provider}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {config?.allowClientKeys ? (
                <div className="mt-1">
                  <p>客户端密钥（BYOK，JSON）：</p>
                  <textarea
                    value={clientKeysText}
                    onChange={(e) => setClientKeysText(e.target.value)}
                    placeholder='{"siliconflow":"sk-...","openai":"sk-..."}'
                    className="mt-1 h-12 w-full resize-none rounded bg-[#161b22] p-1.5 font-mono text-[9px] text-[#c9d1d9] ring-1 ring-[#21262d] outline-none focus:ring-[#1a8cff]"
                  />
                  <p className="text-[9px] text-[#6e7681]">仅当 ALLOW_CLIENT_KEYS=是 时，提交工作流会携带这些密钥覆盖服务端配置。</p>
                </div>
              ) : (
                <p className="mt-1 text-[9px] text-[#6e7681]">客户端密钥下发已关闭，密钥由服务端统一管理。</p>
              )}
            </div>
          </details>

          <button
            type="button"
            onClick={() => void runTestChain()}
            disabled={chain.state === 'running'}
            className="inline-flex items-center gap-1 rounded-lg bg-[#1a8cff]/15 px-2.5 py-1 text-[10px] font-medium text-[#1a8cff] transition hover:bg-[#1a8cff]/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {chain.state === 'running' ? '链路测试中…' : '测试链路'}
          </button>
          {chain.state === 'running' && (
            <div className="space-y-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-[#21262d]">
                <div className="h-full rounded-full bg-[#1a8cff] transition-all duration-300" style={{ width: `${Math.max(chain.percent, 3)}%` }} />
              </div>
              <p className="text-[10px] text-[#6e7681]">{chain.node ? `节点 ${chain.node}` : '提交中…'} {Math.round(chain.percent)}%</p>
            </div>
          )}
          {chain.state === 'done' && (
            <div className="space-y-1">
              <p className="text-[11px] text-[#00d4aa]">链路打通 ✅ 成片：</p>
              <div className="flex flex-wrap gap-2">
                {chain.outputs.map((o, idx) =>
                  /\.(png|jpe?g|gif|webp)$/i.test(o.url) ? (
                    <img key={idx} src={o.url} alt="output" className="h-20 rounded-lg ring-1 ring-[#21262d]" />
                  ) : (
                    <a key={idx} href={o.url} target="_blank" rel="noreferrer" className="text-[10px] text-[#1a8cff] underline">{o.type || 'file'}: {o.url}</a>
                  ),
                )}
              </div>
            </div>
          )}
          {chain.state === 'error' && (
            <p className="text-[10px] text-[#f85149]">链路测试失败 ❌ {chain.error}</p>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-[#8b949e]">当前未接入 ComfyUI（不影响画布其它功能使用）。</p>
          <details className="group rounded-lg bg-[#0f1317] p-2 ring-1 ring-[#21262d]">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] text-[#c9d1d9] marker:content-none">
              <span>安装说明</span>
              <ChevronDown className="h-3 w-3 text-[#8b949e] transition group-open:rotate-180" />
            </summary>
            <div className="mt-2 space-y-2">
          <p className="text-[10px] text-[#9aa4af]">{guidance.installHint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleStartComfy()}
              disabled={comfyStarting}
              className="inline-flex items-center gap-1 rounded-lg bg-[#1a8cff]/15 px-2.5 py-1 text-[10px] font-medium text-[#1a8cff] transition hover:bg-[#1a8cff]/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {comfyStarting ? '正在启动…' : '启动 ComfyUI'}
            </button>
            <button
              type="button"
              onClick={() => openComfyUiWeb()}
              className="inline-flex items-center gap-1 rounded-lg border border-[#2d3236] bg-[#121518] px-2.5 py-1 text-[10px] text-[#c9d1d9] transition hover:border-[#46515d]"
            >
              打开 ComfyUI 网页
            </button>
            <p className="text-[9px] text-[#6e7681]">已安装则点「启动」；未安装请按下方步骤安装。</p>
          </div>
          <ol className="list-decimal space-y-1 pl-4 text-[10px] text-[#c9d1d9]">
            <li>
              从官方仓库安装：
              <a href={guidance.downloadUrl} target="_blank" rel="noreferrer" className="ml-1 text-[#1a8cff] underline">{guidance.downloadUrl}</a>
            </li>
            <li>
              运行一键安装脚本（克隆 + 安装依赖，默认 CPU 模式）：
              <code className="ml-1 rounded bg-[#0f1317] px-1.5 py-0.5 font-mono text-[#9bf5df]">{guidance.installScript}</code>
            </li>
            <li>
              启动 ComfyUI（默认监听 <span className="font-mono">{guidance.defaultPort}</span>），本网关会自动接入。
            </li>
            <li>
              点击「重新检测」，状态变为「已接入」即可使用。文档：
              <a href={guidance.docsUrl} target="_blank" rel="noreferrer" className="ml-1 text-[#1a8cff] underline">{guidance.docsUrl}</a>
            </li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleInstallManager()}
              disabled={managerInstalling}
              className="inline-flex items-center gap-1 rounded-lg bg-[#7a4b2a]/15 px-2.5 py-1 text-[10px] font-medium text-[#ffcf9e] transition hover:bg-[#7a4b2a]/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {managerInstalling ? '安装中…' : '一键安装 ComfyUI-Manager'}
            </button>
            <a href="https://github.com/ltdrdata/ComfyUI-Manager" target="_blank" rel="noreferrer" className="text-[10px] text-[#1a8cff] underline">手动安装说明</a>
          </div>
          <p className="text-[10px] text-[#9aa4af]">
            ComfyUI-Manager 是<strong className="text-[#e6edf3]">独立的自定义节点</strong>，默认并不随 ComfyUI 安装——所以你打开网页后<strong className="text-[#e6edf3]">看不到 Manager 按钮</strong>。点上方按钮会自动把它克隆到 ComfyUI 的 <span className="font-mono">custom_nodes/ComfyUI-Manager</span>，重启 ComfyUI 后顶部菜单即出现 Manager，可用来安装/更新各类插件节点。
          </p>
          <p className="rounded-lg bg-[#0f1317] p-2 text-[10px] text-[#9aa4af]">
            提示：实际生图还需一个 checkpoint 模型（.ckpt/.safetensors），请放入 ComfyUI 的 models/checkpoints 目录，或在本面板下载模型后指向该路径。
          </p>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

export function ModelDownloadPanel({ active = true }: { active?: boolean } = {}) {
  const [progressList, setProgressList] = useState<ModelDownloadProgress[]>([]);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimePayload>(null);
  const [runtimeDoctor, setRuntimeDoctor] = useState<RuntimeDoctorReport>({ checkedAt: '', runtimes: {} });
  const [runtimeJobs, setRuntimeJobs] = useState<Record<string, RuntimeInstallJob | null>>({});
  const [runtimeUninstalling, setRuntimeUninstalling] = useState<Record<string, boolean>>({});
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  // P1-5: 自定义安装目录跨会话记忆（localStorage 持久化）
  const [runtimeTargetDir, setRuntimeTargetDir] = useState(
    () => localStorage.getItem('hmdao.runtimeTargetDir') || '',
  );
  useEffect(() => {
    const trimmed = runtimeTargetDir.trim();
    if (trimmed) {
      localStorage.setItem('hmdao.runtimeTargetDir', trimmed);
    } else {
      localStorage.removeItem('hmdao.runtimeTargetDir');
    }
  }, [runtimeTargetDir]);

  // P2-1: 安装目录即时校验（选/填目录后立即反馈，无需等到安装报错）
  const [targetDirStatus, setTargetDirStatus] = useState<{ state: 'idle' | 'checking' | 'ok' | 'error'; message: string }>({ state: 'idle', message: '' });
  const validateRuntimeTargetDir = useCallback(async (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed) {
      setTargetDirStatus({ state: 'idle', message: '' });
      return;
    }
    setTargetDirStatus((prev) => ({ ...prev, state: 'checking' }));
    try {
      const res = await fetch('/api/health/local-post/runtime/validate-path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.forbidden) {
        setTargetDirStatus({ state: 'error', message: '该目录受保护，禁止写入（系统目录 / 项目源码目录）。' });
      } else if (data?.exists) {
        setTargetDirStatus({ state: 'ok', message: '目录可用（已存在）。' });
      } else {
        setTargetDirStatus({ state: 'ok', message: '目录可用（将自动创建）。' });
      }
    } catch {
      setTargetDirStatus({ state: 'idle', message: '' });
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => { void validateRuntimeTargetDir(runtimeTargetDir); }, 400);
    return () => clearTimeout(t);
  }, [runtimeTargetDir, validateRuntimeTargetDir]);

  const [runtimePicking, setRuntimePicking] = useState(false);
  // 安装态/版本变化时需要触发重渲染（presetModelInstall 为模块级状态）
  const [, forcePresetTick] = useState(0);
  // NLLB-200 翻译插件为独立注册表（Transformers.js），状态变化需单独触发重渲染
  const [, forceTranslateTick] = useState(0);
  // 浏览器扩展安装状态
  const [extInstalled, setExtInstalled] = useState<boolean | null>(null);
  const [extBuilds, setExtBuilds] = useState<HmdaoBuilds | null>(null);

  // 把统一 build 汇总渲染成一行可读文本（缺项即视为旧版未上报）
  const renderBuildSummary = (b: HmdaoBuilds | null): string => {
    if (!b) return '（旧版，请重载扩展）';
    const part = (label: string, v: string | null) => `${label}:${v ? v : '✗'}`;
    return [
      part('侧栏', b.sidepanel),
      part('后台', b.background),
      part('检测', b.detect),
      part('注入', b.injectMain),
    ].join(' · ');
  };

  useEffect(() => {
    // ★性能：面板不可见时停止 300ms 进度轮询（常驻面板不再后台空转）
    if (!active) return undefined;
    const timer = setInterval(() => {
      setProgressList(getAllDownloadProgress());
    }, 300);
    return () => clearInterval(timer);
  }, [active]);

  // 挂载时基于 IndexedDB 真实缓存重新判定「已安装」并做版本检查（刷新/重登后不丢状态）
  useEffect(() => {
    void initPresetInstalledState().then(() => forcePresetTick((tick) => tick + 1));
    void checkPresetUpdates().finally(() => forcePresetTick((tick) => tick + 1));
    const unsubscribe = subscribePresetInstall(() => forcePresetTick((tick) => tick + 1));
    // 刷新后后台重建已安装本地模型的真实运行器（保持面板状态与可用性一致）
    void reactivateInstalledLocalModels();
    const onLocalModelsChanged = () => forcePresetTick((tick) => tick + 1);
    window.addEventListener('hmdao-local-models-changed', onLocalModelsChanged);
    return () => {
      unsubscribe();
      window.removeEventListener('hmdao-local-models-changed', onLocalModelsChanged);
    };
  }, []);

  // 订阅 NLLB-200 翻译插件状态变化（独立于 PRESET_MODELS / ORT 运行器注册表）
  useEffect(() => {
    const unsub = onLocalTranslateStateChange(() => forceTranslateTick((tick) => tick + 1));
    return () => unsub();
  }, []);



  const loadRuntimeStatus = useCallback(async (refresh = false) => {
    setRuntimeLoading(true);
    setRuntimeError('');
    try {
      const response = await fetch(refresh ? '/api/health/local-post/refresh' : '/api/health', {
        method: refresh ? 'POST' : 'GET',
        headers: refresh ? { 'Content-Type': 'application/json' } : undefined,
      });
      if (!response.ok) {
        throw new Error(`运行时状态请求失败：HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null) as RuntimePayload;
      setRuntimeStatus(payload);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : '加载运行时状态失败。');
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  const runRuntimeDoctor = useCallback(async (force = false) => {
    setDoctorLoading(true);
    setRuntimeError('');
    try {
      const response = await fetch(`/api/health/local-post/doctor${force ? '?force=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRelease: force }),
      });
      if (!response.ok) {
        throw new Error(`运行时自检失败：HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null) as ({
        checkedAt?: string;
        runtimes?: RuntimeDoctorReport['runtimes'];
      } & Record<string, unknown>) | null;
      setRuntimeDoctor({
        checkedAt: String(payload?.checkedAt || ''),
        runtimes: payload?.runtimes || {},
      });
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : '运行时自检失败。');
    } finally {
      setDoctorLoading(false);
    }
  }, []);

  const loadRuntimeInstallJobs = useCallback(async () => {
    try {
      const auth = readRuntimeAuth();
      const jobsQuery = auth.deviceId ? `?deviceId=${encodeURIComponent(auth.deviceId)}` : '';
      const response = await fetch(`/api/health/local-post/runtime/install-jobs${jobsQuery}`);
      if (!response.ok) {
        throw new Error(response.status === 401 || response.status === 402
          ? '需要先在扩展内登录 / 开启试用后才能查看云端安装任务。'
          : `运行时安装任务读取失败：HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null) as { jobs?: RuntimeInstallJob[] } | null;
      const nextJobs = Object.fromEntries(
        (payload?.jobs || []).map((job) => [job.runtimeKey, job]),
      ) as Record<string, RuntimeInstallJob | null>;
      setRuntimeJobs((previous) => ({ ...previous, ...nextJobs }));
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : '读取安装任务失败。');
    }
  }, []);

  useEffect(() => {
    // ★注意：这里【不要】自动执行 runRuntimeDoctor。
    //   以前挂载即全量自检，用户一打开面板就满屏红色「自检失败」——
    //   用户尚未安装这些本地运行时，失败是预期状态，不该以失败告警的形式呈现。
    //   现在改为：仅加载「已配置/已发现」状态与安装任务；自检结果只在
    //   用户点「安装后一键自检」或安装任务完成（runRuntimeDoctor(true)）后才展示。
    void loadRuntimeStatus(false);
    void loadRuntimeInstallJobs();
  }, [loadRuntimeInstallJobs, loadRuntimeStatus]);

  useEffect(() => {
    const activeJobs = Object.values(runtimeJobs).filter((job) => isRuntimeJobActive(job));
    if (!activeJobs.length) return undefined;
    const timer = setInterval(() => {
      void loadRuntimeInstallJobs();
    }, 1200);
    return () => clearInterval(timer);
  }, [loadRuntimeInstallJobs, runtimeJobs]);

  useEffect(() => {
    const finishedJob = Object.values(runtimeJobs).find((job) => job?.status === 'succeeded');
    if (!finishedJob) return;
    void loadRuntimeStatus(true);
    void runRuntimeDoctor(true);
  }, [loadRuntimeStatus, runRuntimeDoctor, runtimeJobs]);

  const handleDownload = useCallback(async (model: PresetModel, force = false) => {
    if (downloadingIds.has(model.id)) return;
    setDownloadingIds((previous) => new Set(previous).add(model.id));
    try {
      if (model.localRunner && model.localRunner !== 'imgly') {
        // 下载真实 onnx 权重（含拆分式外部权重，如 Depth Anything V3 的 model.onnx_data）。
        // extraFiles 交给 loadModel 一并下载+缓存+回读校验，否则激活时取外部权重会失败。
        const res = await loadModel({
          modelId: model.id,
          version: model.version,
          url: model.url,
          extraFiles: model.extraFiles,
          timeout: 600000,
          retries: 2,
          force,
        });
        if (!res.success) throw new Error(res.error || '模型下载失败');
        const act = await activateLocalModel(model.id, model.version);
        if (!act.ok) throw new Error(act.reason || '模型激活失败');
      } else if (model.localRunner === 'imgly') {
        const act = await activateLocalModel(model.id, model.version);
        if (!act.ok) throw new Error(act.reason || '模型激活失败');
      } else {
        const res = await loadModel({
          modelId: model.id,
          version: model.version,
          url: model.url,
          timeout: 600000,
          retries: 2,
          force,
        });
        if (!res.success) throw new Error(res.error || '模型下载失败');
      }
      markPresetInstalled(model.id, model.version);
      await initPresetInstalledState();
      forcePresetTick((tick) => tick + 1);
    } catch (error) {
      console.error(`[ModelDownloadPanel] download/activate failed: ${model.id}`, error);
    } finally {
      setDownloadingIds((previous) => {
        const next = new Set(previous);
        next.delete(model.id);
        return next;
      });
    }
  }, [downloadingIds]);

  const handleActivate = useCallback(async (model: PresetModel) => {
    if (downloadingIds.has(model.id)) return;
    setDownloadingIds((previous) => new Set(previous).add(model.id));
    try {
      const act = await activateLocalModel(model.id, model.version);
      if (!act.ok) throw new Error(act.reason || '模型激活失败');
      forcePresetTick((tick) => tick + 1);
    } catch (error) {
      console.error(`[ModelDownloadPanel] activate failed: ${model.id}`, error);
    } finally {
      setDownloadingIds((previous) => {
        const next = new Set(previous);
        next.delete(model.id);
        return next;
      });
    }
  }, [downloadingIds, forcePresetTick]);

  const handleRuntimeInstall = useCallback(async (runtimeKey: RuntimeCardItem['id']) => {
    if (isRuntimeJobActive(runtimeJobs[runtimeKey])) return;
    setRuntimeError('');
    try {
      // 服务端闸门需身份（已授权设备 / 运维 Key），本机直连由回环放行
      const auth = readRuntimeAuth();
      const installQuery = auth.deviceId ? `?deviceId=${encodeURIComponent(auth.deviceId)}` : '';
      const response = await fetch(`/api/health/local-post/runtime/install${installQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtimeKey,
          requestedAction: runtimeDoctor.runtimes[runtimeKey]?.update?.updateAvailable ? 'update' : 'install',
          targetDir: runtimeTargetDir.trim(),
          deviceId: auth.deviceId,
          token: auth.token,
        }),
      });
      if (response.status === 401) throw new Error(INSTALL_AUTH_HINT_401);
      if (response.status === 402) throw new Error(INSTALL_AUTH_HINT_402);
      if (!response.ok) {
        throw new Error(`启动安装失败：HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null) as { job?: RuntimeInstallJob } | null;
      if (payload?.job) {
        setRuntimeJobs((previous) => ({ ...previous, [runtimeKey]: payload.job || null }));
      }
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : '启动安装失败。');
    }
  }, [runtimeDoctor.runtimes, runtimeJobs]);

  // 本地卸载：删除运行时安装目录（含自定义/中文路径目录）+ 下载缓存，并刷新探测状态
  const handleRuntimeUninstall = useCallback(async (runtimeKey: RuntimeCardItem['id']) => {
    if (isRuntimeJobActive(runtimeJobs[runtimeKey])) return;
    if (!window.confirm('确认卸载该运行时？将删除本地安装目录与下载缓存（不影响系统自装的同名工具）。')) return;
    setRuntimeError('');
    setRuntimeUninstalling((previous) => ({ ...previous, [runtimeKey]: true }));
    try {
      const response = await fetch('/api/health/local-post/runtime/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtimeKey }),
      });
      if (!response.ok) {
        throw new Error(`卸载失败：HTTP ${response.status}`);
      }
      setRuntimeJobs((previous) => ({ ...previous, [runtimeKey]: null }));
      await loadRuntimeStatus(true);
      await runRuntimeDoctor(true);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : '卸载失败。');
    } finally {
      setRuntimeUninstalling((previous) => ({ ...previous, [runtimeKey]: false }));
    }
  }, [runtimeJobs, loadRuntimeStatus, runRuntimeDoctor]);

  // 打开系统文件夹选择框（后端 FolderBrowserDialog，支持中文路径），回填安装目录
  const handlePickRuntimeTargetDir = useCallback(async () => {
    if (runtimePicking) return;
    setRuntimePicking(true);
    try {
      const picked = await pickAssetLibraryDirectory(runtimeTargetDir || '', '');
      if (!picked.canceled && picked.path) {
        setRuntimeTargetDir(picked.path);
      }
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : '打开目录选择器失败。');
    } finally {
      setRuntimePicking(false);
    }
  }, [runtimePicking, runtimeTargetDir]);

  const handleClear = useCallback(async (modelId: string, version: string, extraFiles?: PresetModel['extraFiles']) => {
    clearProgress(modelId, version);
    deactivateLocalModel(modelId);
    clearPresetInstalled(modelId);
    try {
      await deleteCachedModel(modelId, version);
      for (const ef of extraFiles ?? []) {
        await deleteCachedModel(modelId, `${version}#${ef.name}`);
      }
    } finally {
      setProgressList(getAllDownloadProgress());
      await initPresetInstalledState();
      forcePresetTick((tick) => tick + 1);
    }
  }, []);

  const activeProgress = progressList.filter((item) => item.status === 'downloading' || item.status === 'pending');
  const completedProgress = progressList.filter((item) => item.status === 'completed' || item.status === 'cached');

  const runtimeCards = useMemo<RuntimeCardItem[]>(() => {
    const localPostBackends = runtimeStatus?.capabilities?.localPostBackends;
    return [
      {
        id: 'oiio',
        title: 'OpenImageIO oiiotool',
        scope: '严格图片调色 / LUT / 色彩空间转换 / OCIO config 深度校验',
        purpose: '专业级图像读写与色彩运算引擎：LUT 应用、色彩空间转换、OCIO config 深度校验',
        sourceNode: '图像后期节点（调色 / LUT / 色彩管理）',
        status: localPostBackends?.oiio || null,
        doctor: runtimeDoctor.runtimes.oiio,
        job: runtimeJobs.oiio || null,
      },
      {
        id: 'gmic',
        title: 'G\'MIC CLI',
        scope: 'Bloom / Grain / 锐化 / 细节修复',
        purpose: '图像滤镜处理引擎：Bloom 辉光、胶片颗粒、锐化、细节修复等本地特效',
        sourceNode: '图像后期节点（滤镜 / 特效）',
        status: localPostBackends?.gmic || null,
        doctor: runtimeDoctor.runtimes.gmic,
        job: runtimeJobs.gmic || null,
      },
      {
        id: 'ocio',
        title: 'OpenColorIO Runtime',
        scope: '官方 ACES config / OCIO Runtime / 真实颜色管理链路',
        purpose: '颜色管理运行时：加载官方 ACES config，提供真实颜色管理链路',
        sourceNode: '图像后期节点（颜色管理 / ACES）',
        status: localPostBackends?.ocio || null,
        doctor: runtimeDoctor.runtimes.ocio,
        job: runtimeJobs.ocio || null,
      },
      {
        id: 'ytdlp',
        title: 'yt-dlp（YouTube 直链采集）',
        scope: '浏览器扩展采集 YouTube / B站 / 抖音等平台直链所依赖的命令行工具',
        purpose: '视频平台直链解析工具：为采集扩展解析 YouTube / B站 / 抖音等平台的可下载直链',
        sourceNode: '素材库 · 网络资产采集（浏览器扩展）',
        status: localPostBackends?.ytdlp || null,
        doctor: runtimeDoctor.runtimes.ytdlp,
        job: runtimeJobs.ytdlp || null,
      },
      {
        id: 'florence2',
        title: 'Florence-2 视觉理解（本地免费）',
        scope: '图片描述 / 主体识别 / 局部语义 / 提示词反推（零远程 Token，本机运行）',
        purpose: '微软开源本地视觉模型（Florence-2-large）。图片分析节点走本地推理，无需任何远程 Token，替代旧的占位兜底链路；安装即可用，可在安装时自定义模型目录',
        sourceNode: '图片分析节点（视觉理解 / 反推）',
        status: localPostBackends?.florence2 || null,
        doctor: runtimeDoctor.runtimes.florence2,
        job: runtimeJobs.florence2 || null,
      },
      {
        id: 'aria2',
        title: 'Aria2 下载引擎（网盘多线程直链下载）',
        scope: '浏览器扩展采集的迅雷 / 百度 / 夸克等网盘直链，由后端转发 Aria2 接管下载',
        purpose: '高性能多线程下载引擎：为采集扩展提供网盘直链高速下载（断点续传、多线程），不占用浏览器内存；与 yt-dlp 同属素材下载引擎组',
        sourceNode: '素材库 · 网络资产采集（浏览器扩展）',
        status: localPostBackends?.aria2 || null,
        doctor: runtimeDoctor.runtimes.aria2,
        job: runtimeJobs.aria2 || null,
      },
      {
        id: 'ffmpeg',
        title: 'FFmpeg（yt-dlp 音视频合并依赖）',
        scope: 'yt-dlp 处理 m3u8 分片 / 合并音视频流所必需的独立命令行工具',
        purpose: '音视频处理核心工具：yt-dlp 下载后自动合并音视频流、转码；与 aria2 / yt-dlp 同属素材下载引擎组',
        sourceNode: '素材库 · 网络资产采集（浏览器扩展）',
        status: localPostBackends?.ffmpeg || null,
        doctor: runtimeDoctor.runtimes.ffmpeg,
        job: runtimeJobs.ffmpeg || null,
      },
    ];
  }, [runtimeDoctor, runtimeJobs, runtimeStatus]);

  // P0-1: 三分区状态摘要徽标
  const localModels = PRESET_MODELS.filter((m) => m.browserRuntime !== 'nllb');
  const localInstalledCount = localModels.filter((m) => getPresetInstallHealth(m.id).status === 'installed').length;
  const localModelSummary = `${localInstalledCount}/${localModels.length} 已安装`;
  const runtimeConfiguredCount = runtimeCards.filter((c) => c.status?.configured).length;
  const runtimeSummary = `${runtimeConfiguredCount}/${runtimeCards.length} 已接入`;

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="model-download-panel">
      <div className="border-b border-[#21262d] px-4 py-3">
        <h3 className="text-sm font-semibold text-[#e6edf3]">模型下载</h3>
        <p className="mt-0.5 text-[10px] text-[#6e7681]">模型缓存、后期运行时依赖和安装后自检统一管理</p>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto p-3">
        {/* ===== 分区一：本地模型 ===== */}
        <div style={{ order: 3 }}>
        <PluginZone title="本地模型" accent="blue" summary={localModelSummary} subtitle="ComfyUI 引擎 · 本地模型权重">
        {activeProgress.length > 0 ? (
          <div className="space-y-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">下载中</span>
            {activeProgress.map((progress) => {
              const agg = aggregateProgressBytes(progress);
              const hasExtra = (progress.extraFiles?.length ?? 0) > 0;
              const aggPercent = agg.total > 0 ? Math.round((agg.downloaded / agg.total) * 100) : progress.percent;
              return (
              <div key={`${progress.modelId}-${progress.version}`} className="space-y-2 rounded-xl bg-[#161b22] p-3 ring-1 ring-[#21262d]">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#00d4aa]" />
                  <span className="text-xs font-medium text-[#c9d1d9]">{progress.modelId}</span>
                  <span className="ml-auto text-[10px] text-[#6e7681]">{aggPercent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#21262d]">
                  <div className="h-full rounded-full bg-[#00d4aa] transition-all duration-300" style={{ width: `${aggPercent}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-[#6e7681]">
                  <span>{formatBytes(agg.downloaded)} / {formatBytes(agg.total)}</span>
                  <span>{formatSpeed(progress.speed)}</span>
                  {hasExtra ? <span className="text-[#f59e0b]">含 {(progress.extraFiles || []).length} 个外部权重</span> : null}
                </div>
                {hasExtra ? (
                  <div className="space-y-1 rounded-lg bg-[#0f1317] p-2">
                    {(progress.extraFiles || []).map((ef) => {
                      const ep = ef.total > 0 ? Math.round((ef.downloaded / ef.total) * 100) : 0;
                      return (
                        <div key={ef.name} className="flex items-center gap-2 text-[9px] text-[#9aa4af]">
                          <span className="truncate font-mono">{ef.name}</span>
                          <div className="ml-auto h-1 flex-1 overflow-hidden rounded-full bg-[#21262d]">
                            <div className="h-full rounded-full bg-[#1a8cff]" style={{ width: `${ep}%` }} />
                          </div>
                          <span className="w-12 text-right">{formatBytes(ef.downloaded)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              );
            })}
          </div>
        ) : null}

        <ComfyEngineCard />

        <div className="space-y-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">可用模型</span>
          {PRESET_MODELS.filter((model) => model.browserRuntime !== 'nllb').map((model) => {
            const progress = progressList.find((item) => item.modelId === model.id);
            const isDownloading = downloadingIds.has(model.id);
            const installHealth = getPresetInstallHealth(model.id);
            const isInstalled = installHealth.status === 'installed';
            const needsRepair = installHealth.status === 'needs-repair';
            const isActive = !model.localRunner || hasLocalModelRunner(model.id);
            const isDone = isInstalled;
            const hasError = progress?.status === 'error';
            const updateInfo = getPresetUpdateInfo(model);

            return (
              <details key={model.id} className="group rounded-xl bg-[#161b22] ring-1 ring-[#21262d]" data-testid={`preset-model-${model.id}`}>
                <summary className="flex cursor-pointer list-none items-start gap-3 p-3 marker:content-none">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    needsRepair
                      ? 'bg-[#f59e0b]/15'
                      : isDone
                        ? 'bg-[#00d4aa]/15'
                        : hasError
                          ? 'bg-[#f85149]/15'
                          : 'bg-[#1a8cff]/15'
                  }`}>
                    {needsRepair ? (
                      <AlertCircle className="h-4 w-4 text-[#f59e0b]" />
                    ) : isDone ? (
                      <CheckCircle2 className="h-4 w-4 text-[#00d4aa]" />
                    ) : hasError ? (
                      <AlertCircle className="h-4 w-4 text-[#f85149]" />
                    ) : isDownloading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[#1a8cff]" />
                    ) : (
                      <Download className="h-4 w-4 text-[#1a8cff]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium text-[#c9d1d9]">{model.name}</p>
                      {model.status === 'pending' ? (
                        <span className="rounded bg-[#6e7681]/20 px-1.5 py-0.5 text-[9px] font-medium text-[#8b949e]">
                          待完善
                        </span>
                      ) : needsRepair ? (
                        <span className="rounded bg-[#f59e0b]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#fbd38d]">
                          待修复
                        </span>
                      ) : updateInfo.updateAvailable ? (
                        <span className="rounded bg-[#f59e0b]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#fbd38d]">
                          有更新
                        </span>
                      ) : model.localRunner && isInstalled && !isActive ? (
                        <span className="rounded bg-[#f59e0b]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#fbd38d]">
                          需激活
                        </span>
                      ) : isDone ? (
                        <span className="rounded bg-[#00d4aa]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#9bf5df]">
                          已安装
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-[10px] text-[#6e7681]">
                      {model.purpose || model.desc}
                      {model.node ? ` · 节点：${model.node}` : ''}
                      {model.status === 'pending' ? ' · 链路未打通，暂不可用' : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                    {model.status === 'pending' ? (
                      <button
                        type="button"
                        disabled
                        title="后端路由与安装链路未打通，暂不可用，待后续完善"
                        className="cursor-not-allowed rounded-lg bg-[#21262d] px-2.5 py-1 text-[10px] font-medium text-[#6e7681]"
                      >
                        待完善
                      </button>
                    ) : needsRepair ? (
                      <button
                        type="button"
                        disabled={isDownloading}
                        onClick={() => void handleDownload(model, true)}
                        className={`rounded-lg px-2.5 py-1 text-[10px] font-medium transition-colors ${
                          isDownloading
                            ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
                            : 'bg-[#f59e0b]/15 text-[#fbd38d] hover:bg-[#f59e0b]/25'
                        }`}
                      >
                        {isDownloading ? '修复中' : '修复'}
                      </button>
                    ) : isDone && isActive ? (
                      <button
                        type="button"
                        onClick={() => void handleClear(model.id, model.version, model.extraFiles)}
                        className="flex h-6 w-6 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#f85149]/10 hover:text-[#f85149]"
                        title="清除缓存"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    ) : hasError ? (
                      <button
                        type="button"
                        onClick={() => void handleDownload(model, true)}
                        className="flex h-6 w-6 items-center justify-center rounded-lg text-[#f85149] transition-colors hover:bg-[#00d4aa]/10 hover:text-[#00d4aa]"
                        title="重试下载"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    ) : model.localRunner && isInstalled && !isActive ? (
                      <button
                        type="button"
                        disabled={isDownloading}
                        onClick={() => void handleActivate(model)}
                        className={`rounded-lg px-2.5 py-1 text-[10px] font-medium transition-colors ${
                          isDownloading
                            ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
                            : 'bg-[#1a8cff]/15 text-[#1a8cff] hover:bg-[#1a8cff]/25'
                        }`}
                      >
                        {isDownloading ? '激活中' : '激活'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isDownloading}
                        onClick={() => void handleDownload(model)}
                        className={`rounded-lg px-2.5 py-1 text-[10px] font-medium transition-colors ${
                          isDownloading
                            ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
                            : 'bg-[#1a8cff]/15 text-[#1a8cff] hover:bg-[#1a8cff]/25'
                        }`}
                      >
                        {isDownloading ? '下载中' : '下载'}
                      </button>
                    )}
                  </div>
                  <ChevronDown className="mt-1.5 h-3.5 w-3.5 shrink-0 text-[#6e7681] transition group-open:rotate-180" />
                </summary>
                <div className="border-t border-[#21262d] px-3 pb-3 pt-2">
                  <p className="text-[10px] text-[#6e7681]">{model.desc}</p>
                  {needsRepair ? (
                    <p className="mt-1 text-[10px] text-[#fbd38d]">{installHealth.message}</p>
                  ) : null}
                  <p className="mt-1 text-[10px] text-[#8b949e]">
                    备注：{model.purpose ? `用途：${model.purpose}` : `用途：${model.desc}`}
                    {model.node ? ` · 来源节点：${model.node}` : ''}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[9px] text-[#6e7681]">{model.size}</span>
                    {model.extraFiles?.length ? (
                      <span className="rounded bg-[#f59e0b]/12 px-1.5 py-0.5 text-[9px] text-[#fbd38d]" title={`该模型权重为拆分式（主文件 + 外部权重），下载时会一并拉取：\n${model.extraFiles.map((f) => f.name).join('\n')}`}>
                        +{model.extraFiles.length} 个外部权重
                      </span>
                    ) : null}
                    <span className="text-[9px] text-[#6e7681]">
                      v{model.version}
                      {updateInfo.installedVersion && updateInfo.installedVersion !== model.version
                        ? `（已装 ${updateInfo.installedVersion}）`
                        : ''}
                    </span>
                  </div>
                  {model.extraFiles?.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {model.extraFiles.map((ef) => (
                        <span
                          key={ef.name}
                          className="rounded bg-[#0f1317] px-1.5 py-0.5 font-mono text-[9px] text-[#7cc4ff] ring-1 ring-[#21262d]"
                          title={`外部权重文件 ${ef.name}：需与主文件一同下载/缓存，否则该模型无法在浏览器端激活`}
                        >
                          {ef.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {isDownloading && progress ? (
                    <div className="mt-2 space-y-1">
                      <div className="h-1 overflow-hidden rounded-full bg-[#21262d]">
                        <div className="h-full rounded-full bg-[#1a8cff] transition-all duration-300" style={{ width: `${aggregateProgressBytes(progress).total > 0 ? Math.round((aggregateProgressBytes(progress).downloaded / aggregateProgressBytes(progress).total) * 100) : progress.percent}%` }} />
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-[#6e7681]">
                        <span>{aggregateProgressBytes(progress).total > 0 ? `${Math.round((aggregateProgressBytes(progress).downloaded / aggregateProgressBytes(progress).total) * 100)}%` : `${progress.percent}%`}</span>
                        <span>{formatSpeed(progress.speed)}</span>
                      </div>
                    </div>
                  ) : null}
                  {hasError && progress?.error ? (
                    <p className="mt-1 text-[10px] text-[#f85149]">{progress.error}</p>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>

        {/* 已缓存（P0-1：归入「本地模型」分区） */}
        {completedProgress.length > 0 ? (
          <div className="space-y-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">已缓存</span>
            {completedProgress.map((progress) => {
              const cachedModel = PRESET_MODELS.find((m) => m.id === progress.modelId);
              const efFiles = cachedModel?.extraFiles ?? [];
              return (
                <div key={`${progress.modelId}-${progress.version}`} className="rounded-lg bg-[#161b22] px-3 py-2 ring-1 ring-[#21262d]">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-[#00d4aa]" />
                    <span className="text-xs text-[#c9d1d9]">{progress.modelId}</span>
                    <span className="text-[10px] text-[#6e7681]">v{progress.version}</span>
                    <span className="ml-auto text-[10px] text-[#6e7681]">{formatBytes(progress.totalBytes)}</span>
                    <button
                      type="button"
                      onClick={() => void handleClear(progress.modelId, progress.version, cachedModel?.extraFiles)}
                      className="text-[#8b949e] transition-colors hover:text-[#f85149]"
                      title="清除缓存（含外部权重）"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {efFiles.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1 border-t border-[#21262d] pt-1.5">
                      <span className="text-[9px] text-[#6e7681]">拆分权重：</span>
                      {efFiles.map((ef) => (
                        <span
                          key={ef.name}
                          className="rounded bg-[#0f1317] px-1.5 py-0.5 font-mono text-[9px] text-[#7cc4ff] ring-1 ring-[#21262d]"
                          title={`外部权重文件 ${ef.name}：拆分式模型的一部分，需随主文件一并缓存`}
                        >
                          {ef.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {progressList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[#6e7681]">
            <HardDrive className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">暂无模型缓存</p>
            <p className="mt-1 text-[10px]">模型下载后可离线使用；运行时依赖安装完成后，会在上方卡片里显示自检和更新结果。</p>
          </div>
        ) : null}
        </PluginZone>
        </div>

        {/* ===== 分区三：浏览器内模型 ===== */}
        <div style={{ order: 1 }}>
        <PluginZone title="浏览器内模型" accent="purple" summary="本地运行" subtitle="NLLB 翻译 · 搜索 / 素材采集扩展">
        {/* ===== 浏览器扩展安装入口（MV3，Chrome / Edge 通用） ===== */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">Ddayup网页素材采集扩展</span>
            <button
              type="button"
              onClick={async () => {
                const ok = await detectHmdaoExtension();
                setExtInstalled(ok);
                setExtBuilds(ok ? await fetchHmdaoExtBuilds() : null);
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-[#2d3236] bg-[#121518] px-2.5 py-1 text-[10px] text-[#c9d1d9] transition hover:border-[#46515d] hover:bg-[#1b2024]"
            >
              <RefreshCw className="h-3 w-3" />
              检测是否已安装
            </button>
          </div>

          <div className="rounded-xl border border-[#1a8cff]/25 bg-[#0f1822] p-3">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#1a8cff]/15">
                <Download className="h-4 w-4 text-[#7cc4ff]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <img
                    src="/elf-sprite.svg"
                    alt="小精灵"
                    className="h-5 w-5 shrink-0 rounded-md"
                    draggable={false}
                  />
                  <span className="text-[9px] text-[#00d4aa] bg-[#00d4aa]/10 px-1.5 py-0.5 rounded">MV3</span>
                  <span className="text-[9px] text-[#7cc4ff] bg-[#1a8cff]/10 px-1.5 py-0.5 rounded">Edge 商店已上架</span>
                  <span className="text-[9px] text-[#f59e0b] bg-[#f59e0b]/10 px-1.5 py-0.5 rounded">7天免费体验 · 付费</span>
                </div>
                <p className="mt-0.5 text-[10px] text-[#6e7681]">
                  安装即享 7 天免费体验，到期后需订阅（微信 / 国际卡）才能继续采集。可一键采集任意网页的图片 / 视频 / 音效 / 3D 模型，支持「保存到本地自定义目录（含中文路径）」与「导入 Ddayup 素材库」。
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {extInstalled === null ? (
                    <span className="text-[9px] text-[#6e7681]">点击右上「检测是否已安装」确认状态</span>
                  ) : extInstalled ? (
                    <span className="text-[9px] text-[#00d4aa] bg-[#00d4aa]/10 px-1.5 py-0.5 rounded">
                      已安装 ✓ {renderBuildSummary(extBuilds)} · 在素材库点「网络资产采集」直接使用
                    </span>
                  ) : (
                    <span className="text-[9px] text-[#d29922] bg-[#d29922]/10 px-1.5 py-0.5 rounded">未安装，点击下方「从 Edge 商店安装」</span>
                  )}
                </div>
              </div>
            </div>

            {/* 首选：Edge 加载项商店一键安装（链接由扩展 ID 决定，永久不变） */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <a
                href={EXTENSION_STORE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#1f6feb] bg-[#1f6feb]/15 px-2.5 py-1.5 text-[10px] font-medium text-[#7cc4ff] transition hover:bg-[#1f6feb]/25"
              >
                <ExternalLink className="h-3 w-3" />
                从 Edge 加载项商店安装
              </a>
              <span className="text-[9px] text-[#6e7681]">安装后由 Edge 自动保持最新版本</span>
            </div>

            {/* 安装说明（默认折叠） */}
            <details className="group mt-3 border-t border-[#21262d] pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] text-[#c9d1d9] marker:content-none">
                <span>安装说明 / 备用方案</span>
                <ChevronDown className="h-3 w-3 text-[#8b949e] transition group-open:rotate-180" />
              </summary>
              <ol className="mt-2 space-y-1.5 text-[10px] leading-5 text-[#9aa4af]">
                <li>1. 点上方「从 Edge 加载项商店安装」，在商店页点「获取」即完成安装（推荐，后续自动更新）。</li>
                <li>2. 安装后扩展即生效；在素材库点「网络资产采集」即可。</li>
                <li>3. 也可直接点击浏览器工具栏的 Ddayup 扩展图标，自动打开采集侧栏并扫描当前页。</li>
                <li className="text-[#8b949e]">该商店链接永久不变（由扩展 ID 决定，与版本无关），无需随版本更新更换。</li>
              </ol>

              {/* 备用方案：本地加载 —— 仅本地开发环境展示（线上自动隐藏，避免外部二次加载/二次开发）。
                  线上站点访问时 SHOW_DEV_INSTALL=false，整块不渲染，页面不含任何 edge://extensions 字样。 */}
              {SHOW_DEV_INSTALL && (
                <details className="mt-2 border-t border-[#21262d] pt-2">
                  <summary className="cursor-pointer text-[10px] text-[#8b949e]">备用方案：本地加载（本地开发 / 调试用）</summary>
                  <ol className="mt-1.5 space-y-1.5 text-[10px] leading-5 text-[#9aa4af]">
                    <li>1. 打开浏览器扩展页：Chrome 访问 <code className="text-[#7cc4ff]">chrome://extensions</code>，Edge 访问 <code className="text-[#7cc4ff]">edge://extensions</code>，并开启「开发者模式」。</li>
                    <li>2. 点「加载已解压的扩展程序」，选择本项目目录下的 <code className="text-[#7cc4ff]">extension/</code> 文件夹。</li>
                    <li>3. 此方式不会自动更新、需手动重载；普通用户请优先使用上方商店安装。</li>
                  </ol>
                </details>
              )}
            </details>

            <div className="mt-2 flex items-center gap-2">
              <span className="text-[9px] text-[#6e7681]">支持中文路径保存：在扩展侧栏点「选择保存目录」设定本地路径即可。</span>
            </div>
          </div>
        </div>

        {/* 浏览器端本地模型（NLLB-200 翻译等） */}
        <div className="space-y-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">浏览器端模型</span>

          {/* NLLB-200 翻译：单一数据源 PRESET_MODELS（browserRuntime:'nllb'），与 ORT 模型同一面板、同一渲染路径 */}
          {PRESET_MODELS.filter((model) => model.browserRuntime === 'nllb').map((model) => (
            <NllbModelCard key={model.id} model={model} />
          ))}
        </div>

        {/* 搜索扩展包 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">搜索与 AI 扩展包</span>
            <span className="text-[9px] text-[#00d4aa] bg-[#00d4aa]/10 px-2 py-0.5 rounded-full">免费内置</span>
          </div>
          <p className="text-[10px] text-[#8b949e]">
            以下扩展包已内置在系统中，点击安装即可激活。发布后其他用户从模型下载面板一键获取。
          </p>
          {SEARCH_EXTENSIONS.map((ext) => (
            <details key={ext.id} className="group rounded-xl bg-[#161b22] ring-1 ring-[#21262d]">
              <summary className="flex cursor-pointer list-none items-center gap-3 p-3 marker:content-none">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#00d4aa]/15">
                  <CheckCircle2 className="h-4 w-4 text-[#00d4aa]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-[#c9d1d9]">{ext.name}</p>
                    <span className="text-[9px] text-[#00d4aa] bg-[#00d4aa]/10 px-1.5 py-0.5 rounded">已激活</span>
                  </div>
                  <p className="truncate text-[10px] text-[#6e7681]">
                    {ext.purpose || ext.desc}
                    {ext.node ? ` · 节点：${ext.node}` : ''}
                  </p>
                </div>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#6e7681] transition group-open:rotate-180" />
              </summary>
              <div className="border-t border-[#21262d] px-3 pb-3 pt-2">
                <p className="text-[10px] text-[#6e7681]">{ext.desc}</p>
                <p className="mt-1 text-[10px] text-[#8b949e]">
                  备注：用途：{ext.purpose || ext.desc}
                  {ext.node ? ` · 来源节点：${ext.node}` : ''}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[9px] text-[#6e7681]">{ext.size}</span>
                  <span className="text-[9px] text-[#6e7681]">v{ext.version}</span>
                </div>
              </div>
            </details>
          ))}
        </div>
        </PluginZone>
        </div>

        {/* ===== 分区二：运行时插件 ===== */}
        <div style={{ order: 2 }}>
        <PluginZone title="运行时插件" accent="green" summary={runtimeSummary} subtitle="OpenImageIO · G'MIC · OCIO · yt-dlp · Florence-2">
        <div className="space-y-2" data-testid="model-download-runtime-section">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">运行时依赖（后期 / 采集）</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void loadRuntimeStatus(true)}
                disabled={runtimeLoading}
                className="inline-flex items-center gap-1 rounded-lg border border-[#2d3236] bg-[#121518] px-2.5 py-1 text-[10px] text-[#c9d1d9] transition hover:border-[#46515d] hover:bg-[#1b2024] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RefreshCw className={`h-3 w-3 ${runtimeLoading ? 'animate-spin' : ''}`} />
                {runtimeLoading ? '刷新中…' : '刷新状态'}
              </button>
              <button
                type="button"
                onClick={() => void runRuntimeDoctor(true)}
                disabled={doctorLoading}
                className="inline-flex items-center gap-1 rounded-lg border border-[#24564a] bg-[#102a23] px-2.5 py-1 text-[10px] text-[#d8fff7] transition hover:border-[#2d7b66] hover:bg-[#123429] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ShieldCheck className={`h-3 w-3 ${doctorLoading ? 'animate-pulse' : ''}`} />
                {doctorLoading ? '自检中…' : '安装后一键自检'}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[#2a2f35] bg-[#101418] px-3 py-2 text-[10px] leading-5 text-[#9aa4af]">
            这里可以直接一键下载安装 `G&apos;MIC`、`OpenImageIO`、`OpenColorIO`。
            安装完成后会自动做本机自检，并把节点里的运行时状态同步刷新。
          </div>

          <div className="rounded-xl border border-[#2a2f35] bg-[#0f1317] px-3 py-2">
            <p className="text-[10px] font-medium text-[#e6edf3]">自定义安装目录（可选）</p>
            <p className="mt-1 text-[9px] text-[#6e7681]">
              留空则安装到默认数据目录；填写绝对路径可指定安装位置（支持中文路径，如 D:\我的工具\运行时，方便统一管理）。
              后续「更新替换」会自动沿用本目录，「卸载」也会从该目录删除。禁止写入 Windows/Program Files 及项目源码目录。
            </p>
            <div className="mt-1 flex items-center gap-2">
              <input
                value={runtimeTargetDir}
                onChange={(e) => setRuntimeTargetDir(e.target.value)}
                placeholder="D:\我的工具\运行时（支持中文路径）"
                className="min-w-0 flex-1 rounded bg-[#161b22] p-1.5 font-mono text-[9px] text-[#c9d1d9] ring-1 ring-[#21262d] outline-none focus:ring-[#1a8cff]"
              />
              <button
                type="button"
                onClick={() => void handlePickRuntimeTargetDir()}
                disabled={runtimePicking}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-[#2d3236] bg-[#121518] px-2 py-1.5 text-[10px] text-[#c9d1d9] transition hover:border-[#46515d] disabled:opacity-60"
                title="在系统中浏览并选择安装目录（支持中文路径）"
              >
                <HardDrive className={`h-3 w-3 ${runtimePicking ? 'animate-spin' : ''}`} />
                {runtimePicking ? '选择中…' : '选择文件夹'}
              </button>
            </div>
            {targetDirStatus.state !== 'idle' ? (
              <div
                data-testid="target-dir-status"
                className={`mt-1.5 flex items-center gap-1 text-[9px] ${
                  targetDirStatus.state === 'error'
                    ? 'text-[#f85149]'
                    : targetDirStatus.state === 'checking'
                      ? 'text-[#6e7681]'
                      : 'text-[#00d4aa]'
                }`}
              >
                {targetDirStatus.state === 'checking' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : targetDirStatus.state === 'ok' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                <span>{targetDirStatus.message}</span>
              </div>
            ) : null}
          </div>

          {runtimeCards.map((runtime) => {
            const status = runtime.status;
            const configured = status?.configured === true;
            const detected = Boolean(status?.detectedPath);
            const statusBadge = runtimeBadge(configured, detected);
            const doctor = runtime.doctor;
            const doctorState = doctorBadge(doctor?.status);
            const nextUpdate = updateBadge(doctor?.update);
            const jobState = installBadge(runtime.job, doctor);

            return (
              <details key={runtime.id} className="group rounded-xl bg-[#161b22] ring-1 ring-[#21262d]" data-testid={`runtime-card-${runtime.id}`}>
                <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl p-3 marker:content-none">
                  <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    configured ? 'bg-[#00d4aa]/15' : detected ? 'bg-[#f59e0b]/15' : 'bg-[#1a8cff]/15'
                  }`}>
                    {configured ? (
                      <CheckCircle2 className="h-4 w-4 text-[#00d4aa]" />
                    ) : detected ? (
                      <AlertCircle className="h-4 w-4 text-[#f59e0b]" />
                    ) : isRuntimeJobActive(runtime.job) ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[#1a8cff]" />
                    ) : (
                      <Download className="h-4 w-4 text-[#1a8cff]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-medium text-[#c9d1d9]">{runtime.title}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[9px] ${statusBadge.className}`}>{statusBadge.label}</span>
                      {doctor && doctorState ? <span className={`rounded-full px-2 py-0.5 text-[9px] ${doctorState.className}`}>{doctorState.label}</span> : null}
                      <span className={`rounded-full px-2 py-0.5 text-[9px] ${nextUpdate.className}`}>{nextUpdate.label}</span>
                      {jobState ? <span className={`rounded-full px-2 py-0.5 text-[9px] ${jobState.className}`}>{jobState.label}</span> : null}
                    </div>
                    <p className="mt-0.5 text-[10px] text-[#6e7681]">{runtime.scope}</p>
                    {runtime.id === 'ytdlp' && extInstalled && !detected && (
                      <p className="mt-0.5 text-[10px] text-[#d9a441]">
                        ⚠ 浏览器扩展已安装，但 yt-dlp 未就绪：YouTube / B站 视频的清晰度选择与下载将不可用，请点「安装」后重扫扩展即可生效。
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#9aa4af]">
                      <span>{installedVersionSummary(doctor, runtime.job)}</span>
                      {doctor?.update?.latestVersion ? <span>最新版本 {doctor.update.latestVersion}</span> : null}
                      {runtime.job?.message ? <span>{runtime.job.message}</span> : null}
                    </div>
                  </div>
                  <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-[#8b949e] transition group-open:rotate-180" />
                </summary>

                <div className="border-t border-[#21262d] px-3 py-3">
                  <div className="space-y-3 text-[10px] leading-5 text-[#aab4bf]">
                    <div className="rounded-xl border border-[#2a2f35] bg-[#0f1317] px-3 py-3">
                      <div className="font-medium text-[#e6edf3]">基础状态</div>
                      <div className="mt-2 space-y-1">
                        <div>备注：用途：{runtime.purpose}</div>
                        <div>来源节点：{runtime.sourceNode}</div>
                        <div>能力：{runtimeCapabilityLabel(status)}</div>
                        <div>探测路径：{status?.detectedPath || '未检测到'}</div>
                        {status?.detectedConfigPath ? <div>当前 Config：{status.detectedConfigPath}</div> : null}
                        <div>环境变量：{status?.envPath || '未声明'}{status?.envCommand ? ` / ${status.envCommand}` : ''}</div>
                        <div>常见安装路径：{commonInstallPathLabel(status)}</div>
                        <div>安装提示：{status?.installHint || '安装后再执行一次自检即可。'}</div>
                        <div>成功提示：{status?.successHint || '探测成功后会自动切到真实链路。'}</div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#2a2f35] bg-[#0f1317] px-3 py-3">
                      <div className="font-medium text-[#e6edf3]">安装 / 更新</div>
                      <div className="mt-2 space-y-2">
                        <div>{runtime.job?.message || '支持一键下载安装，更新时会自动切到最新版。'}</div>
                        {isRuntimeJobActive(runtime.job) ? (
                          <div className="space-y-1">
                            <div className="h-1.5 overflow-hidden rounded-full bg-[#21262d]">
                              <div className="h-full rounded-full bg-[#1a8cff] transition-all duration-300" style={{ width: `${runtime.job?.progress || 0}%` }} />
                            </div>
                            <div className="flex items-center justify-between text-[9px] text-[#6e7681]">
                              <span>阶段：{runtime.job?.stage || 'queued'}</span>
                              <span>{runtime.job?.progress || 0}%</span>
                            </div>
                          </div>
                        ) : null}
                        {runtime.job?.error ? <div className="text-[#ffb4b4]">错误：{runtime.job.error}</div> : null}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={isRuntimeJobActive(runtime.job)}
                            onClick={() => void handleRuntimeInstall(runtime.id)}
                            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] transition ${
                              isRuntimeJobActive(runtime.job)
                                ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
                                : 'bg-[#1a8cff]/15 text-[#7cc4ff] hover:bg-[#1a8cff]/25'
                            }`}
                          >
                            {isRuntimeJobActive(runtime.job) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                            {runtimeActionLabel(runtime)}
                          </button>
                          <button
                            type="button"
                            disabled={
                              isRuntimeJobActive(runtime.job)
                              || Boolean(runtimeUninstalling[runtime.id])
                              || !(doctor?.installedVersion || status?.detectedPath)
                            }
                            onClick={() => void handleRuntimeUninstall(runtime.id)}
                            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] transition ${
                              isRuntimeJobActive(runtime.job) || runtimeUninstalling[runtime.id] || !(doctor?.installedVersion || status?.detectedPath)
                                ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
                                : 'bg-[#f85149]/12 text-[#ffb4b4] hover:bg-[#f85149]/22'
                            }`}
                            title="删除本面板安装的运行时目录与下载缓存"
                          >
                            {runtimeUninstalling[runtime.id] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            卸载
                          </button>
                          {doctor?.update?.releaseUrl ? (
                            <a
                              href={doctor.update.releaseUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-lg border border-[#2d3236] bg-[#121518] px-2.5 py-1 text-[10px] text-[#c9d1d9] transition hover:border-[#46515d] hover:bg-[#1b2024]"
                            >
                              <ExternalLink className="h-3 w-3" />
                              发布页
                            </a>
                          ) : null}
                          {status?.docsUrl ? (
                            <a
                              href={status.docsUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-lg border border-[#2d3236] bg-[#121518] px-2.5 py-1 text-[10px] text-[#c9d1d9] transition hover:border-[#46515d] hover:bg-[#1b2024]"
                            >
                              <ExternalLink className="h-3 w-3" />
                              文档
                            </a>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#2a2f35] bg-[#0f1317] px-3 py-3">
                      <div className="font-medium text-[#e6edf3]">安装后一键自检 / 更新检查</div>
                      {doctor ? (
                        <div className="mt-2 space-y-1">
                          <div>自检结论：{doctor.summary}</div>
                          {doctor.installedVersion ? <div>本机版本：{doctor.installedVersion}</div> : null}
                          {doctor.configSummary ? <div>Config 校验：{doctor.configSummary}</div> : null}
                          {doctor.checkedCommand?.length ? <div>检查命令：{doctor.checkedCommand.join(' ')}</div> : null}
                          {doctor.elapsedMs ? <div>耗时：{doctor.elapsedMs} ms</div> : null}
                          <div>更新状态：{updateSummary(doctor)}</div>
                          {doctor.suggestions?.length ? <div>处理建议：{doctor.suggestions.join(' / ')}</div> : null}
                          {doctor.stderr ? <div>错误输出：{doctor.stderr}</div> : null}
                          {!doctor.stderr && doctor.stdout ? <div>命令输出：{doctor.stdout}</div> : null}
                        </div>
                      ) : (
                        <div className="mt-2 text-[#8b949e]">当前还没有自检结果。安装完成后点上方“安装后一键自检”，面板和节点会一起同步状态。</div>
                      )}
                    </div>
                  </div>
                </div>
              </details>
            );
          })}

          {runtimeDoctor.checkedAt ? (
            <div className="text-[10px] text-[#6e7681]">最近一次运行时自检：{runtimeDoctor.checkedAt}</div>
          ) : null}

          {runtimeError ? (
            <div className="rounded-xl border border-[#f85149]/20 bg-[#f85149]/8 px-3 py-2 text-[10px] text-[#ffb4b4]">
              {runtimeError}
            </div>
          ) : null}
        </div>
        </PluginZone>
        </div>
      </div>
    </div>
  );
}

