import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
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
import { LocalModelPanel } from '@/components/LocalModelPanel';
import { PRESET_MODELS, SEARCH_EXTENSIONS, type PresetModel } from '@/config/presetModels';
import {
  checkPresetUpdates,
  clearPresetInstalled,
  getPresetInstallState,
  getPresetUpdateInfo,
  initPresetInstalledState,
  markPresetInstalled,
  subscribePresetInstall,
} from '@/services/presetModelInstall';
import { hasLocalModelRunner } from '@/services/localModelRunner';
import {
  activateLocalModel,
  deactivateLocalModel,
  reactivateInstalledLocalModels,
} from '@/services/localInference';

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
  };
};

type RuntimePayload = {
  capabilities?: {
    localPostBackends?: {
      ocio?: RuntimeBackendStatus;
      oiio?: RuntimeBackendStatus;
      gmic?: RuntimeBackendStatus;
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
  id: 'oiio' | 'gmic' | 'ocio';
  title: string;
  scope: string;
  status: RuntimeBackendStatus | null;
  doctor?: RuntimeDoctorRuntime;
  job?: RuntimeInstallJob | null;
}

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
  if (status === 'ok') return { className: 'bg-[#00d4aa]/12 text-[#9bf5df]', label: '自检通过' };
  if (status === 'warn') return { className: 'bg-[#f59e0b]/12 text-[#fbd38d]', label: '需补完整链路' };
  return { className: 'bg-[#f85149]/12 text-[#ffb4b4]', label: '自检失败' };
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

export function ModelDownloadPanel() {
  const [progressList, setProgressList] = useState<ModelDownloadProgress[]>([]);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimePayload>(null);
  const [runtimeDoctor, setRuntimeDoctor] = useState<RuntimeDoctorReport>({ checkedAt: '', runtimes: {} });
  const [runtimeJobs, setRuntimeJobs] = useState<Record<string, RuntimeInstallJob | null>>({});
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  // 安装态/版本变化时需要触发重渲染（presetModelInstall 为模块级状态）
  const [, forcePresetTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setProgressList(getAllDownloadProgress());
    }, 300);
    return () => clearInterval(timer);
  }, []);

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
      const response = await fetch('/api/health/local-post/runtime/install-jobs');
      if (!response.ok) {
        throw new Error(`运行时安装任务读取失败：HTTP ${response.status}`);
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
    void loadRuntimeStatus(false);
    void runRuntimeDoctor(false);
    void loadRuntimeInstallJobs();
  }, [loadRuntimeInstallJobs, loadRuntimeStatus, runRuntimeDoctor]);

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

  const handleDownload = useCallback(async (model: PresetModel) => {
    if (downloadingIds.has(model.id)) return;
    setDownloadingIds((previous) => new Set(previous).add(model.id));
    try {
      if (model.localRunner && model.localRunner !== 'imgly') {
        // 下载真实 onnx 权重
        const res = await loadModel({
          modelId: model.id,
          version: model.version,
          url: model.url,
          timeout: 600000,
          retries: 2,
        });
        if (!res.success) throw new Error(res.error || '模型下载失败');
        // 下载即安装：建立 ORT 会话并注册真实运行器
        const act = await activateLocalModel(model.id, model.version);
        if (!act.ok) throw new Error(act.reason || '模型激活失败');
      } else if (model.localRunner === 'imgly') {
        // @imgly 由包自身运行时下载模型，这里仅注册运行器
        const act = await activateLocalModel(model.id, model.version);
        if (!act.ok) throw new Error(act.reason || '模型激活失败');
      } else {
        await loadModel({
          modelId: model.id,
          version: model.version,
          url: model.url,
          timeout: 600000,
          retries: 2,
        });
      }
      // 真实激活成功后才标记「已安装」，确保面板状态与可用性一致
      markPresetInstalled(model.id, model.version);
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
  }, [downloadingIds, forcePresetTick]);

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
      const response = await fetch('/api/health/local-post/runtime/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtimeKey,
          requestedAction: runtimeDoctor.runtimes[runtimeKey]?.update?.updateAvailable ? 'update' : 'install',
        }),
      });
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

  const handleClear = useCallback((modelId: string, version: string) => {
    clearProgress(modelId, version);
    clearPresetInstalled(modelId);
    deactivateLocalModel(modelId);
    setProgressList(getAllDownloadProgress());
    forcePresetTick((tick) => tick + 1);
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
        status: localPostBackends?.oiio || null,
        doctor: runtimeDoctor.runtimes.oiio,
        job: runtimeJobs.oiio || null,
      },
      {
        id: 'gmic',
        title: 'G\'MIC CLI',
        scope: 'Bloom / Grain / 锐化 / 细节修复',
        status: localPostBackends?.gmic || null,
        doctor: runtimeDoctor.runtimes.gmic,
        job: runtimeJobs.gmic || null,
      },
      {
        id: 'ocio',
        title: 'OpenColorIO Runtime',
        scope: '官方 ACES config / OCIO Runtime / 真实颜色管理链路',
        status: localPostBackends?.ocio || null,
        doctor: runtimeDoctor.runtimes.ocio,
        job: runtimeJobs.ocio || null,
      },
    ];
  }, [runtimeDoctor, runtimeJobs, runtimeStatus]);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="model-download-panel">
      <div className="border-b border-[#21262d] px-4 py-3">
        <h3 className="text-sm font-semibold text-[#e6edf3]">模型下载</h3>
        <p className="mt-0.5 text-[10px] text-[#6e7681]">模型缓存、后期运行时依赖和安装后自检统一管理</p>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {activeProgress.length > 0 ? (
          <div className="space-y-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">下载中</span>
            {activeProgress.map((progress) => (
              <div key={`${progress.modelId}-${progress.version}`} className="space-y-2 rounded-xl bg-[#161b22] p-3 ring-1 ring-[#21262d]">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#00d4aa]" />
                  <span className="text-xs font-medium text-[#c9d1d9]">{progress.modelId}</span>
                  <span className="ml-auto text-[10px] text-[#6e7681]">{progress.percent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#21262d]">
                  <div className="h-full rounded-full bg-[#00d4aa] transition-all duration-300" style={{ width: `${progress.percent}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-[#6e7681]">
                  <span>{formatBytes(progress.downloadedBytes)} / {formatBytes(progress.totalBytes)}</span>
                  <span>{formatSpeed(progress.speed)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="space-y-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">可用模型</span>
          {PRESET_MODELS.map((model) => {
            const progress = progressList.find((item) => item.modelId === model.id);
            const isDownloading = downloadingIds.has(model.id);
            const isInstalled = getPresetInstallState(model.id) !== null;
            const isActive = !model.localRunner || hasLocalModelRunner(model.id);
            const isDone =
              progress?.status === 'completed' ||
              progress?.status === 'cached' ||
              isInstalled;
            const hasError = progress?.status === 'error';
            const updateInfo = getPresetUpdateInfo(model);

            return (
              <div key={model.id} className="rounded-xl bg-[#161b22] p-3 ring-1 ring-[#21262d]">
                <div className="flex items-start gap-3">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    isDone ? 'bg-[#00d4aa]/15' : hasError ? 'bg-[#f85149]/15' : 'bg-[#1a8cff]/15'
                  }`}>
                    {isDone ? (
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
                      {updateInfo.updateAvailable ? (
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
                    <p className="text-[10px] text-[#6e7681]">{model.desc}</p>
                    {model.node || model.purpose ? (
                      <p className="text-[9px] text-[#6e7681]">
                        {model.node ? `作用节点：${model.node}` : ''}
                        {model.node && model.purpose ? ' · ' : ''}
                        {model.purpose ? `用途：${model.purpose}` : ''}
                      </p>
                    ) : null}
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[9px] text-[#6e7681]">{model.size}</span>
                      <span className="text-[9px] text-[#6e7681]">
                        v{model.version}
                        {updateInfo.installedVersion && updateInfo.installedVersion !== model.version
                          ? `（已装 ${updateInfo.installedVersion}）`
                          : ''}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isDone && isActive ? (
                      <button
                        type="button"
                        onClick={() => handleClear(model.id, model.version)}
                        className="flex h-6 w-6 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#f85149]/10 hover:text-[#f85149]"
                        title="清除缓存"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    ) : hasError ? (
                      <button
                        type="button"
                        onClick={() => handleDownload(model)}
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
                        onClick={() => handleDownload(model)}
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
                </div>
                {isDownloading && progress ? (
                  <div className="mt-2 space-y-1">
                    <div className="h-1 overflow-hidden rounded-full bg-[#21262d]">
                      <div className="h-full rounded-full bg-[#1a8cff] transition-all duration-300" style={{ width: `${progress.percent}%` }} />
                    </div>
                    <div className="flex items-center justify-between text-[9px] text-[#6e7681]">
                      <span>{progress.percent}%</span>
                      <span>{formatSpeed(progress.speed)}</span>
                    </div>
                  </div>
                ) : null}
                {hasError && progress?.error ? (
                  <p className="mt-1 text-[10px] text-[#f85149]">{progress.error}</p>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* 浏览器端本地模型（NLLB-200 翻译等） */}
        <div className="space-y-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">浏览器端模型</span>
          <LocalModelPanel />
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
          {SEARCH_EXTENSIONS.map((ext) => {
            const isInstalled = true; // 内置扩展默认已安装
            return (
              <div key={ext.id} className="rounded-xl bg-[#161b22] p-3 ring-1 ring-[#21262d]">
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#00d4aa]/15">
                    <CheckCircle2 className="h-4 w-4 text-[#00d4aa]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[#c9d1d9]">{ext.name}</p>
                    <p className="text-[10px] text-[#6e7681]">{ext.desc}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[9px] text-[#6e7681]">{ext.size}</span>
                      <span className="text-[9px] text-[#6e7681]">v{ext.version}</span>
                      <span className="text-[9px] text-[#00d4aa] bg-[#00d4aa]/10 px-1.5 py-0.5 rounded">已激活</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-2" data-testid="model-download-runtime-section">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">后期运行时依赖</span>
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
                      {doctor ? <span className={`rounded-full px-2 py-0.5 text-[9px] ${doctorState.className}`}>{doctorState.label}</span> : null}
                      <span className={`rounded-full px-2 py-0.5 text-[9px] ${nextUpdate.className}`}>{nextUpdate.label}</span>
                      {jobState ? <span className={`rounded-full px-2 py-0.5 text-[9px] ${jobState.className}`}>{jobState.label}</span> : null}
                    </div>
                    <p className="mt-0.5 text-[10px] text-[#6e7681]">{runtime.scope}</p>
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

        {completedProgress.length > 0 ? (
          <div className="space-y-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">已缓存</span>
            {completedProgress.map((progress) => (
              <div key={`${progress.modelId}-${progress.version}`} className="flex items-center gap-2 rounded-lg bg-[#161b22] px-3 py-2 ring-1 ring-[#21262d]">
                <CheckCircle2 className="h-3 w-3 text-[#00d4aa]" />
                <span className="text-xs text-[#c9d1d9]">{progress.modelId}</span>
                <span className="text-[10px] text-[#6e7681]">v{progress.version}</span>
                <span className="ml-auto text-[10px] text-[#6e7681]">{formatBytes(progress.totalBytes)}</span>
                <button
                  type="button"
                  onClick={() => handleClear(progress.modelId, progress.version)}
                  className="text-[#8b949e] transition-colors hover:text-[#f85149]"
                  title="清除缓存"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {progressList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[#6e7681]">
            <HardDrive className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">暂无模型缓存</p>
            <p className="mt-1 text-[10px]">模型下载后可离线使用；运行时依赖安装完成后，会在上方卡片里显示自检和更新结果。</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
