import { useCallback, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  getMissingComfyProviders,
  comfyValidate,
  startComfyUi,
  type ComfyValidateResult,
} from '@/services/comfyui/comfyuiClient';
import { ComfyUIExecutor } from '@/services/workflowEngine';
import { useComfyTaskStore } from '@/store/useComfyTaskStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useAssetStore } from '@/store/useAssetStore';
import { importRemoteAsset } from '@/api/assetLibrary';

// ComfyUI 工作流节点：真实执行由 ComfyUIExecutor 经中转网关完成，
// 此组件在画布上呈现节点（标题 + 运行入口 + 运行状态 + 实时进度 + 成片预览），
// 不暴露 ComfyUI 背后的复杂节点连线界面（需求2）。
export function ComfyUiNode({ id, data, selected }: NodeProps) {
  const params = (data as { params?: Record<string, unknown> } | undefined)?.params || {};
  const label =
    (params.label as string | undefined) ||
    (data as { label?: string } | undefined)?.label ||
    'ComfyUI 工作流';
  const rawJson = params.rawComfyJson;
  const hasJson = Boolean(rawJson);

  // 缺少已激活的云端 provider（已有逻辑）。
  const missingProviders = rawJson ? getMissingComfyProviders(rawJson) : [];
  // 缺少已安装的 ComfyUI 自定义节点插件（需求3，运行时检测后写入）。
  const [validation, setValidation] = useState<ComfyValidateResult | null>(null);
  const [checking, setChecking] = useState(false);
  // 内联粘贴 ComfyUI API JSON（需求1：画布直接调用的入口之一）。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // 订阅本节点的实时进度（key 为画布节点 id）；comfyNodeId 优先，否则用节点 id。
  const comfyNodeId = (params.comfyNodeId as string | undefined) || id;
  const task = useComfyTaskStore((s) => s.tasks[comfyNodeId]);
  const running = task && (task.phase === 'running' || task.phase === 'queued');

  const updateNodeData = useCanvasStore((s) => s.updateNodeData);

  // 打开 ComfyUI 实例界面（ComfyUI-Manager 是 ComfyUI Web UI 内置面板，
  // 已安装时跳过去点 Manager 安装插件；未安装时跳转 Manager 仓库引导先装 Manager）。
  const openComfyUi = useCallback(() => {
    const url =
      validation?.instance_url ||
      (validation?.comfy_manager_installed === false ? validation?.manager_github_url : null) ||
      'http://127.0.0.1:8188';
    if (url) window.open(url, '_blank', 'noopener');
  }, [validation]);

  const revalidate = useCallback(async () => {
    if (!rawJson) return;
    setChecking(true);
    try {
      const result = await comfyValidate(rawJson).catch(() => null);
      setValidation(result);
    } finally {
      setChecking(false);
    }
  }, [rawJson]);

  // 将生成的图片可靠落盘到素材库（服务端经网关拉取，避免只停留在临时预览而无法使用）。
  const [savingAsset, setSavingAsset] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const addAssetItem = useAssetStore((s) => s.addItem);
  const handleSaveToLibrary = useCallback(async () => {
    const url = task?.outputs?.[0]?.url;
    if (!url) return;
    setSavingAsset(true);
    setSaveMsg(null);
    try {
      const item = await importRemoteAsset(url, {
        name: `${label || 'comfy'}-output.png`,
        type: 'image',
      });
      if (item?.item?.id) {
        setSaveMsg('已保存到素材库');
        void addAssetItem(item.item);
      } else {
        setSaveMsg('保存失败');
      }
    } catch (e) {
      setSaveMsg(`保存失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setSavingAsset(false);
    }
  }, [task, label, addAssetItem]);

  const handleStartComfy = useCallback(async () => {
    const r = await startComfyUi();
    if (r?.needsInstall && r.installUrl) window.open(r.installUrl, '_blank', 'noopener');
    else if (r?.alreadyRunning || r?.launched) openComfyUi();
  }, [openComfyUi]);

  const handleSaveJson = useCallback(() => {
    setJsonError(null);
    if (!draft.trim()) {
      updateNodeData(id, { params: { ...params, rawComfyJson: undefined } });
      setEditing(false);
      return;
    }
    try {
      const parsed = JSON.parse(draft);
      const isPromptGraph =
        parsed && typeof parsed === 'object' &&
        (parsed.prompt !== undefined || parsed.nodes !== undefined || hasComfyNodesLike(parsed));
      if (!isPromptGraph) {
        setJsonError('不是有效的 ComfyUI 工作流（需含 prompt 图或 nodes）');
        return;
      }
      updateNodeData(id, { params: { ...params, rawComfyJson: parsed } });
      setValidation(null);
      setEditing(false);
    } catch {
      setJsonError('JSON 解析失败，请检查格式');
    }
  }, [draft, id, params, updateNodeData]);

  const handleRun = useCallback(async () => {
    if (!rawJson || running) return;
    setChecking(true);
    try {
      // 提交前检测工作流所需自定义节点（插件）与模型文件是否已就绪。
      const result = await comfyValidate(rawJson).catch(() => null);
      setValidation(result);
      const hasMissingNodes = !!(result && result.success && (result.missing?.length || 0) > 0);
      // 本地实例的模型缺失检测可靠（已知 subdir），直接阻断；远程实例仅提示。
      const hasMissingModels = !!(
        result && result.missing_models && result.missing_models.some((m) => m.subdir)
      );
      if (hasMissingNodes || hasMissingModels) {
        // 检测到缺失依赖，中止运行，由节点内提示用户补齐（装插件 / 放模型文件）。
        return;
      }
      // 复用已有 ComfyUIExecutor：提交 + 轮询进度 + 写 useComfyTaskStore（结果回传画布）。
      const executor = new ComfyUIExecutor();
      const controller = new AbortController();
      void executor.execute(id, {
        type: 'comfyui',
        label,
        position: { x: 0, y: 0 },
        data: { params: { rawComfyJson: rawJson, comfyNodeId } },
      }, controller.signal);
    } finally {
      setChecking(false);
    }
  }, [rawJson, running, label, id, comfyNodeId]);

  const missingPlugins = validation?.missing_plugins || [];
  const missingNodes = validation?.missing || [];
  const missingModels = validation?.missing_models || [];
  const blockByPlugins = missingPlugins.length > 0 || missingNodes.length > 0;
  const blockByModels = missingModels.some((m) => m.subdir);
  const blockByDeps = blockByPlugins || blockByModels;

  return (
    <div
      className={`comfyui-node rounded-xl border p-3 text-xs ${
        selected ? 'border-[#00d4aa] bg-[#0d1117]' : 'border-[#30363d] bg-[#0d1117]'
      }`}
    >
      <div className="mb-1 font-medium text-[#7ee787]">ComfyUI 工作流</div>
      <div className="truncate text-[#c9d1d9]">{label}</div>

      {/* 缺失依赖（插件 / 模型文件）时，明确提示并指引补齐 */}
      {blockByDeps ? (
        <div className="mt-2 space-y-2 rounded-lg border border-[#f0a8a8] bg-[#2a1416] p-2">
          <div className="font-medium text-[#f0a8a8]">⚠ 缺少必要依赖，无法运行</div>

          {blockByPlugins && (
            <>
              <div className="text-[#f0c0c0]">
                未安装的 ComfyUI 自定义节点（请到 ComfyUI 中用 Manager 安装）：
              </div>
              <ul className="list-disc space-y-0.5 pl-4 text-[#f0c0c0]">
                {missingNodes.slice(0, 6).map((n) => (
                  <li key={n.class_type} className="font-mono text-[10px]">
                    {n.class_type}
                    {n.guess_plugin ? `（插件：${n.guess_plugin}）` : ''}
                  </li>
                ))}
                {missingNodes.length > 6 ? (
                  <li className="text-[#d99]">…等 {missingNodes.length} 个节点</li>
                ) : null}
              </ul>
              {validation?.comfy_manager_installed === true ? (
                <button
                  type="button"
                  onClick={openComfyUi}
                  className="mt-1 w-full rounded-md bg-[#00d4aa] px-2 py-1 text-[11px] font-semibold text-[#06231d] transition-colors hover:bg-[#33e0bb]"
                >
                  打开 ComfyUI（点击 Manager 安装以上插件）
                </button>
              ) : (
                <div className="space-y-1">
                  <div className="text-[#f0c0c0]">未检测到 ComfyUI-Manager，请先安装：</div>
                  <button
                    type="button"
                    onClick={openComfyUi}
                    className="w-full rounded-md bg-[#00d4aa] px-2 py-1 text-[11px] font-semibold text-[#06231d] transition-colors hover:bg-[#33e0bb]"
                  >
                    打开 ComfyUI-Manager 安装仓库
                  </button>
                </div>
              )}
            </>
          )}

          {missingModels.length > 0 && (
            <div className="text-[#f0c0c0]">
              <div>缺失模型 / 权重文件（下载后放入 ComfyUI 的 models/&lt;子目录&gt;）：</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {missingModels.slice(0, 6).map((m) => (
                  <li key={m.node_id + m.file} className="font-mono text-[10px]">
                    {m.file}
                    {m.subdir ? ` → models/${m.subdir}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {validation?.disk_warning && validation?.disk_free_gb != null && (
            <div className="rounded border border-[#f0c08a] bg-[#2a2416] p-1 text-[#f0c08a]">
              ComfyUI 磁盘剩余约 {validation.disk_free_gb} GB。模型 / VAE 等权重文件通常数
              GB~数十 GB，请提前规划硬盘空间。
            </div>
          )}

          <button
            type="button"
            onClick={revalidate}
            className="w-full rounded-md border border-[#30363d] bg-[#161b22] px-2 py-1 text-[11px] text-[#8b949e] transition-colors hover:text-[#e6edf3]"
          >
            已安装 / 已放置模型，重新校验依赖
          </button>
        </div>
      ) : missingProviders.length > 0 ? (
        <div className="mt-2 rounded-lg border border-[#f0a8a8] bg-[#2a1416] p-2 text-[#f0a8a8]">
          需激活云端模型：{missingProviders.join('、')}（请到 API 密钥管理激活）
        </div>
      ) : task ? (
        <div className="mt-1">
          <div className="text-[#8b949e]">
            {task.phase === 'done'
              ? '✓ 完成'
              : task.phase === 'error'
                ? `✗ ${task.error || '失败'}`
                : task.phase === 'queued'
                  ? '排队中…'
                  : `运行中 ${Math.round(task.percent)}%`}
          </div>
          {running && (
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[#21262d]">
              <div
                className="h-full bg-[#00d4aa] transition-all"
                style={{ width: `${Math.max(2, Math.min(100, task.percent))}%` }}
              />
            </div>
          )}
          {task.stepLabel && <div className="mt-1 text-[#6e7681]">{task.stepLabel}</div>}
          {/* 需求2：画布仅展示运行结果，不暴露节点界面 */}
          {task.phase === 'done' && task.outputs[0]?.url && (
            <>
              <img
                src={task.outputs[0].url}
                alt="output"
                className="mt-1 max-h-24 w-full rounded border border-[#30363d] object-cover"
              />
              <div className="mt-1 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void handleSaveToLibrary()}
                  disabled={savingAsset}
                  className="rounded border border-[#30363d] bg-[#161b22] px-2 py-0.5 text-[10px] text-[#c9d1d9] transition-colors hover:bg-[#21262d] disabled:opacity-50"
                >
                  {savingAsset ? '保存中…' : '保存到素材库'}
                </button>
                {saveMsg && <span className="text-[10px] text-[#00d4aa]">{saveMsg}</span>}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-1 text-[#8b949e]">
          {hasJson ? '已加载工作流 JSON，可运行' : '请粘贴 ComfyUI API JSON 后运行'}
        </div>
      )}

      {/* 需求1：在画布上直接调用工作流（运行按钮 + 粘贴 JSON 入口） */}
      <div className="mt-2 flex gap-1">
        {hasJson && !blockByPlugins && (
          <button
            type="button"
            onClick={handleRun}
            disabled={running || checking}
            className="flex-1 rounded-md bg-[#1a8cff] px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[#3a9fff] disabled:opacity-50"
          >
            {checking ? '检测中…' : running ? '运行中…' : '运行工作流'}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (!editing && typeof rawJson !== 'undefined') {
              setDraft(JSON.stringify(rawJson, null, 2));
            }
            setEditing((v) => !v);
            setJsonError(null);
          }}
          className="flex-1 rounded-md border border-[#30363d] bg-[#161b22] px-2 py-1 text-[11px] text-[#c9d1d9] transition-colors hover:bg-[#21262d]"
        >
          {editing ? '收起' : '粘贴工作流 JSON'}
        </button>
        <button
          type="button"
          onClick={() => void handleStartComfy()}
          className="flex-1 rounded-md border border-[#7a4b2a] bg-[#2a1c10] px-2 py-1 text-[11px] text-[#ffcf9e] transition-colors hover:bg-[#332312]"
        >
          启动 ComfyUI
        </button>
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='粘贴 ComfyUI API 格式 JSON（含 "prompt" 图或 "nodes" 数组）'
            className="h-28 w-full resize-y rounded-md border border-[#30363d] bg-[#010409] p-1.5 font-mono text-[10px] text-[#c9d1d9] outline-none focus:border-[#00d4aa]"
          />
          {jsonError ? <div className="mt-1 text-[10px] text-[#f0a8a8]">{jsonError}</div> : null}
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={handleSaveJson}
              className="flex-1 rounded-md bg-[#00d4aa] px-2 py-1 text-[11px] font-semibold text-[#06231d] hover:bg-[#33e0bb]"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setJsonError(null); }}
              className="flex-1 rounded-md border border-[#30363d] bg-[#161b22] px-2 py-1 text-[11px] text-[#c9d1d9] hover:bg-[#21262d]"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <Handle type="target" position={Position.Left} className="!bg-[#00d4aa]" />
      <Handle type="source" position={Position.Right} className="!bg-[#00d4aa]" />
    </div>
  );
}

// 启发式判断是否为 ComfyUI 工作流图（节点 id -> {class_type, inputs} 形态）。
function hasComfyNodesLike(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  const values = Object.values(obj);
  return values.some(
    (v) => v && typeof v === 'object' && typeof (v as Record<string, unknown>).class_type === 'string',
  );
}
