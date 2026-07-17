/**
 * 本地模型插件下载面板
 * - 预设模型插件列表，每条包含功能备注、大小、来源
 * - 支持安装/更新/重试/删除
 * - 模型自动适配路径（由 localTranslate.ts 管理）
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
  onLocalTranslateStateChange,
  getLocalTranslateState,
  MODEL_PLUGINS,
  ensureTranslatorLoaded,
  releaseTranslator,
  pauseDownload,
  getWasManuallyPaused,
  checkForModelUpdates,
  recheckInstalled,
  type LocalModelPlugin,
} from '@/services/localTranslate';

type PanelMode = 'inline' | 'card';

export function LocalModelPanel({ mode = 'inline' }: { mode?: PanelMode }) {
  const [plugins, setPlugins] = useState<LocalModelPlugin[]>(() => [...MODEL_PLUGINS]);
  const [installingId, setInstallingId] = useState<string | null>(null);

  useEffect(() => {
    // 初始同步
    setPlugins([...MODEL_PLUGINS]);
    const unsub = onLocalTranslateStateChange(() => {
      setPlugins([...MODEL_PLUGINS]);
    });
    // 挂载时强制按 IndexedDB 实际缓存记录重新判定「已安装」（修复旧版安装的模型刷新后仍显示未安装）
    void recheckInstalled();
    // 检查更新（仅在模型已安装时）
    const state = getLocalTranslateState();
    if (state.status === 'ready') {
      checkForModelUpdates();
    }
    return unsub;
  }, []);

  const handleInstall = useCallback(async (id: string) => {
    if (id !== 'nllb-200-translation') return;
    setInstallingId(id);
    try {
      await ensureTranslatorLoaded();
    } finally {
      setInstallingId(null);
    }
  }, []);

  const handleRetry = useCallback(async (id: string) => {
    if (id !== 'nllb-200-translation') return;
    await releaseTranslator();
    setInstallingId(id);
    try {
      await ensureTranslatorLoaded();
    } finally {
      setInstallingId(null);
    }
  }, []);

  const handleClearCache = useCallback(async (id: string) => {
    if (id !== 'nllb-200-translation') return;
    if (!confirm('确定要清除 NLLB-200 翻译模型缓存吗？下次使用需重新下载约 600MB。')) return;
    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name?.includes('transformers') || db.name?.includes('onnx')) {
          indexedDB.deleteDatabase(db.name!);
        }
      }
      await releaseTranslator();
      setPlugins([...MODEL_PLUGINS]);
    } catch {
      await releaseTranslator();
      setPlugins([...MODEL_PLUGINS]);
    }
  }, []);

  const isCard = mode === 'card';

  return (
    <div className={isCard ? 'rounded-xl border border-[#21262d] bg-[#0d1117] p-4' : ''}>
      {isCard && (
        <div className="mb-3 text-xs font-semibold text-[#8b949e]">
          本地模型插件
        </div>
      )}

      <div className="space-y-2">
        {plugins.map((plugin) => {
          const isPaused = getWasManuallyPaused();

          const statusIcon =
            plugin.status === 'ready' ? CheckCircle :
            plugin.status === 'error' ? AlertTriangle :
            plugin.status === 'downloading' ? Loader2 :
            isPaused ? PauseCircle : Download;

          const statusColor =
            plugin.status === 'ready' ? 'text-emerald-400' :
            plugin.status === 'error' ? 'text-rose-400' :
            plugin.status === 'downloading' ? 'text-amber-400' :
            isPaused ? 'text-amber-400' : 'text-slate-400';

          const statusText =
            plugin.status === 'ready' ? '已安装' :
            plugin.status === 'error' ? '安装失败' :
            plugin.status === 'downloading' ? `下载中 ${plugin.progress}%` :
            isPaused ? `已暂停 (${plugin.progress}%)` : '未安装';

          const isBusy = plugin.status === 'downloading' || installingId === plugin.id;

          return (
            <div
              key={plugin.id}
              className="rounded-lg border border-[#21262d] bg-[#161b22] p-3"
            >
              {/* 头部：名称 + 状态 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Box className="h-4 w-4 text-[#58a6ff]" />
                  <span className="text-sm font-medium text-[#c9d1d9]">{plugin.name}</span>
                </div>
                <div className={`flex items-center gap-1 text-xs font-medium ${statusColor}`}>
                  {statusIcon === Loader2 ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <statusIcon className="h-3.5 w-3.5" />
                  )}
                  {statusText}
                </div>
              </div>

              {/* 功能备注 + 大小 */}
              <div className="mt-1 text-[11px] leading-4 text-[#6e7681]">
                {plugin.description}
                <span className="mx-1 text-[#484f58]">·</span>
                {plugin.size}
                <span className="mx-1 text-[#484f58]">·</span>
                {plugin.source}
              </div>

              {/* 下载/暂停进度条 */}
              {(plugin.status === 'downloading' || isPaused) && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#21262d]">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${isPaused ? 'bg-amber-500/50' : 'bg-amber-500'}`}
                    style={{ width: `${Math.max(plugin.progress, 5)}%` }}
                  />
                </div>
              )}

              {/* 错误提示 */}
              {plugin.status === 'error' && plugin.error && (
                <div className="mt-2 rounded-lg bg-rose-500/5 px-2.5 py-1.5 text-[11px] leading-4 text-rose-300/80">
                  {plugin.error.length > 140 ? plugin.error.slice(0, 140) + '…' : plugin.error}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {plugin.status === 'idle' && !isPaused && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleInstall(plugin.id)}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1 rounded-md bg-[#21262d] px-2.5 py-1 text-[11px] text-[#c9d1d9] hover:bg-[#30363d] disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      安装
                    </button>
                    <button
                      type="button"
                      onClick={() => void recheckInstalled()}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-[#484f58] hover:text-[#8b949e] transition-colors"
                      title="按浏览器本地缓存重新检测模型是否已安装"
                    >
                      <RotateCcw className="h-3 w-3" />
                      重新检测
                    </button>
                  </>
                )}
                {plugin.status === 'idle' && isPaused && (
                  <button
                    type="button"
                    onClick={() => handleInstall(plugin.id)}
                    disabled={isBusy}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    继续下载
                  </button>
                )}
                {plugin.status === 'downloading' && (
                  <button
                    type="button"
                    onClick={() => pauseDownload()}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 hover:bg-amber-500/20"
                  >
                    <PauseCircle className="h-3 w-3" />
                    暂停
                  </button>
                )}
                {plugin.status === 'error' && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleRetry(plugin.id)}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      重试
                    </button>
                    {plugin.error?.includes('密钥') || plugin.error?.includes('API Key') ? (
                      <Link
                        to="/settings/api-keys"
                        className="inline-flex items-center gap-1 rounded-md bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20"
                      >
                        <KeyRound className="h-3 w-3" />
                        配置 API Key
                      </Link>
                    ) : null}
                  </>
                )}
                {plugin.status === 'ready' && (
                  <>
                    {plugin.canUpdate && (
                      <button
                        type="button"
                        onClick={() => handleInstall(plugin.id)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        更新
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleClearCache(plugin.id)}
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
}
