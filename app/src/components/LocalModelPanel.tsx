/**
 * 本地模型插件下载面板（统一管理预设插件模型）
 *
 * 覆盖后期/图片节点的所有浏览器端本地推理模型：
 *   - Depth Anything V3（智能景深 / 3D 旋转）
 *   - BiRefNet（智能抠像，默认引擎，已平替受限的 RMBG-2.0）
 *   - RAFT 光流（运动模糊）
 *   - Real-ESRGAN / LaMa / @imgly 等
 *
 * 每条模型支持：安装（下载权重 → 自动激活推理会话 → 标记已安装）、重试、卸载（注销会话 + 清除缓存）、
 * 「有更新」提示（版本落后时）。下载进度实时显示。模型下载安装后即视为「已安装·可用」，
 * 首次使用时由功能节点（PostNode 等）自动激活，无需额外手动「激活」步骤。
 */
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2,
  Download,
  CheckCircle,
  AlertTriangle,
  PauseCircle,
  RotateCcw,
  Trash2,
  KeyRound,
  Box,
} from 'lucide-react';
import {
  PRESET_MODELS,
  type PresetModel,
  type PresetModelCategory,
} from '@/config/presetModels';
import {
  getPresetInstallHealth,
  markPresetInstalled,
  clearPresetInstalled,
  getPresetUpdateInfo,
  subscribePresetInstall,
  initPresetInstalledState,
} from '@/services/presetModelInstall';
import {
  activateLocalModel,
  deactivateLocalModel,
} from '@/services/localInference';
import { hasLocalModelRunner } from '@/services/localModelRunner';
import { loadModel, getDownloadProgress, verifyExternalWeights } from '@/services/modelLoader';
import { deleteCachedModel } from '@/services/storage';

type PanelMode = 'inline' | 'card';

type ModelStatus = 'idle' | 'downloading' | 'ready' | 'repair' | 'error';

export function LocalModelPanel({ mode = 'inline' }: { mode?: PanelMode }) {
  const [tick, setTick] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 订阅安装状态变化 + 周期刷新下载进度 + 本地模型会话变化
  useEffect(() => {
    // 挂载时从 IndexedDB 真实缓存恢复「已安装」态（与 localStorage 标记合并），
    // 即使未打开 ModelDownloadPanel，刷新/重启后也不再回到「未安装」。
    void initPresetInstalledState().then(() => setTick((t) => t + 1));
    const unsub = subscribePresetInstall(() => setTick((t) => t + 1));
    const onLocal = () => setTick((t) => t + 1);
    window.addEventListener('hmdao-local-models-changed', onLocal);


    let timer: number | undefined;
    const loop = () => {
      // 仅在有下载进行时刷新进度
      const anyDownloading = PRESET_MODELS.some(
        (m) => getDownloadProgress(m.id, m.version)?.status === 'downloading',
      );
      if (anyDownloading) setTick((t) => t + 1);
      timer = window.setTimeout(loop, 400);
    };
    timer = window.setTimeout(loop, 400);

    return () => {
      unsub();
      window.removeEventListener('hmdao-local-models-changed', onLocal);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const deriveStatus = useCallback((model: PresetModel): { status: ModelStatus; progress: number; error?: string } => {
    const prog = getDownloadProgress(model.id, model.version);
    if (prog?.status === 'downloading') {
      return { status: 'downloading', progress: prog.percent };
    }
    if (prog?.status === 'error') {
      return { status: 'error', progress: 0, error: prog.error };
    }
    const active = hasLocalModelRunner(model.id);
    if (active) return { status: 'ready', progress: 100 };
    const installHealth = getPresetInstallHealth(model.id);
    if (installHealth.status === 'installed') {
      return { status: 'ready', progress: 100 };
    }
    if (installHealth.status === 'needs-repair') {
      return { status: 'repair', progress: 0, error: installHealth.message };
    }
    return { status: 'idle', progress: 0 };
  }, []);

  const handleInstall = useCallback(
    async (model: PresetModel, force = false) => {
      setBusyId(model.id);
      setErrors((e) => ({ ...e, [model.id]: '' }));
      try {
        const res = await loadModel({
          modelId: model.id,
          version: model.version,
          url: model.url,
          extraFiles: model.extraFiles,
          timeout: 600000,
          retries: 2,
          force,
        });
        if (!res.success) {
          setErrors((e) => ({ ...e, [model.id]: res.error || '模型下载失败' }));
          return;
        }
        // 安装成功强校验：拆分式模型（如 Depth Anything V3 的 model.onnx_data）
        // 外部权重必须齐备，否则视为安装失败，避免「装好却激活失败」。
        if (model.extraFiles?.length) {
          const { ok, missing } = await verifyExternalWeights(model.id, model.version, model.extraFiles);
          if (!ok) {
            setErrors((e) => ({ ...e, [model.id]: `外部权重缺失（${missing.join(', ')}），请重试安装` }));
            return;
          }
        }
        const act = await activateLocalModel(model.id, model.version);
        if (!act.ok) {
          setErrors((e) => ({ ...e, [model.id]: act.reason || '模型激活失败' }));
          return;
        }
        markPresetInstalled(model.id, model.version);
        await initPresetInstalledState();
      } catch (err) {
        setErrors((e) => ({ ...e, [model.id]: (err as Error)?.message || '模型下载失败' }));
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const handleUninstall = useCallback(async (model: PresetModel) => {
    if (!confirm(`确定要卸载「${model.name}」吗？下次使用需重新下载。`)) return;
    setBusyId(model.id);
    try {
      deactivateLocalModel(model.id);
      clearPresetInstalled(model.id);
      await deleteCachedModel(model.id, model.version);
      if (model.extraFiles) {
        for (const ef of model.extraFiles) {
          await deleteCachedModel(model.id, `${model.version}#${ef.name}`);
        }
      }
    } finally {
      setBusyId(null);
    }
  }, []);

  const isCard = mode === 'card';

  // 按分类分组展示
  const groups: { cat: PresetModelCategory; label: string }[] = [
    { cat: 'image-node', label: '图片 / 深度' },
    { cat: 'post-fx', label: '后期 / 抠像 / 光流' },
    { cat: 'video', label: '视频' },
    { cat: 'audio', label: '音频' },
    { cat: 'search', label: '搜索扩展' },
    { cat: 'system', label: '系统扩展' },
  ];

  return (
    <div className={isCard ? 'rounded-xl border border-[#21262d] bg-[#0d1117] p-4' : ''}>
      {isCard && (
        <div className="mb-3 text-xs font-semibold text-[#8b949e]">本地模型插件</div>
      )}

      <div className="space-y-4">
        {groups.map((group) => {
          const models = PRESET_MODELS.filter((m) => m.category === group.cat && m.browserRuntime !== 'nllb');
          if (!models.length) return null;
          return (
            <div key={group.cat}>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#6e7681]">
                {group.label}
              </div>
              <div className="space-y-2">
                {models.map((model) => {
                  const { status, progress, error } = deriveStatus(model);
                  const updateInfo = getPresetUpdateInfo(model);
                  const isBusy = busyId === model.id || status === 'downloading';
                  const errText = error || errors[model.id];

                  const StatusIcon =
                    status === 'ready' ? CheckCircle :
                    status === 'repair' ? RotateCcw :
                    status === 'error' ? AlertTriangle :
                    status === 'downloading' ? Loader2 : Download;
                  const statusColor =
                    status === 'ready' ? 'text-emerald-400' :
                    status === 'repair' ? 'text-amber-300' :
                    status === 'error' ? 'text-rose-400' :
                    status === 'downloading' ? 'text-amber-400' : 'text-slate-400';
                  const statusText =
                    status === 'ready' ? '已安装 · 可用' :
                    status === 'repair' ? '缓存缺失 · 待修复' :
                    status === 'error' ? '安装失败' :
                    status === 'downloading' ? `下载中 ${Math.round(progress)}%` : '未安装';

                  return (
                    <div
                      key={model.id}
                      className="rounded-lg border border-[#21262d] bg-[#161b22] p-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Box className="h-4 w-4 text-[#58a6ff]" />
                          <span className="text-sm font-medium text-[#c9d1d9]">{model.name}</span>
                          {updateInfo.updateAvailable && status !== 'downloading' && (
                            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                              有更新
                            </span>
                          )}
                          {model.gated && (
                            <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-300">
                              受限
                            </span>
                          )}
                        </div>
                        <div className={`flex items-center gap-1 text-xs font-medium ${statusColor}`}>
                          {StatusIcon === Loader2 ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <StatusIcon className="h-3.5 w-3.5" />
                          )}
                          {statusText}
                        </div>
                      </div>

                      <div className="mt-1 text-[11px] leading-4 text-[#6e7681]">
                        {model.desc}
                        <span className="mx-1 text-[#484f58]">·</span>
                        {model.size}
                      </div>

                      {model.extraFiles?.length ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          <span className="text-[10px] text-[#6e7681]">拆分权重：</span>
                          {model.extraFiles.map((ef) => (
                            <span
                              key={ef.name}
                              className="rounded bg-[#0f1317] px-1.5 py-0.5 font-mono text-[9px] text-[#7cc4ff] ring-1 ring-[#21262d]"
                              title={`外部权重文件 ${ef.name}：拆分式模型的一部分，需随主文件一并下载/缓存，否则该模型无法在浏览器端激活`}
                            >
                              {ef.name}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      {status === 'downloading' && (
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#21262d]">
                          <div
                            className="h-full rounded-full bg-amber-500 transition-all duration-300"
                            style={{ width: `${Math.max(progress, 5)}%` }}
                          />
                        </div>
                      )}

                      {(status === 'error' || status === 'repair') && errText && (
                        <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-[11px] leading-4 ${
                          status === 'repair'
                            ? 'bg-amber-500/8 text-amber-200/90'
                            : 'bg-rose-500/5 text-rose-300/80'
                        }`}>
                          {errText.length > 140 ? errText.slice(0, 140) + '…' : errText}
                        </div>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {status === 'idle' && (
                          <button
                            type="button"
                            onClick={() => handleInstall(model)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 rounded-md bg-[#21262d] px-2.5 py-1 text-[11px] text-[#c9d1d9] hover:bg-[#30363d] disabled:opacity-50"
                          >
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                            安装
                          </button>
                        )}
                        {status === 'downloading' && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            下载中…
                          </span>
                        )}
                        {status === 'repair' && (
                          <button
                            type="button"
                            onClick={() => handleInstall(model, true)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                          >
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                            修复 / 重下
                          </button>
                        )}
                        {status === 'error' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleInstall(model, true)}
                              disabled={isBusy}
                              className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                            >
                              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                              重试
                            </button>
                            {model.gated && (
                              <Link
                                to="/settings/api-keys"
                                className="inline-flex items-center gap-1 rounded-md bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20"
                              >
                                <KeyRound className="h-3 w-3" />
                                配置 HF_TOKEN
                              </Link>
                            )}
                          </>
                        )}
                        {status === 'ready' && (
                          <>
                            {updateInfo.updateAvailable && (
                              <button
                                type="button"
                                onClick={() => handleInstall(model, true)}
                                disabled={isBusy}
                                className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                              >
                                <RotateCcw className="h-3 w-3" />
                                更新
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleUninstall(model)}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-[#484f58] hover:text-[#8b949e] transition-colors"
                              title="清除缓存后下次使用需重新下载"
                            >
                              <Trash2 className="h-3 w-3" />
                              卸载
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
