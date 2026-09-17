import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, KeyRound, Loader2, Maximize2, Minimize2, Send } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ModelActivationPrompt } from '@/components/ModelActivationPrompt';
import { GenerationProgressCard } from '@/components/GenerationProgressCard';
import { GenerationResultCard } from '@/components/GenerationResultCard';
import { ErrorDetailBlock, ProgressBadge } from '@/nodes/NodeShellShared';
import {
  describeGenerationError,
  generateNodeOutputWithFallback,
  GenerationError,
  resolveGenerationAccess,
  type GenerationAccess,
} from '@/services/generation';
import { getSharedMemorySuggestions, type SharedAgentMemory } from '@/services/agentMemory';
import { isUnusableProviderKeyStatus, useApiKeyStore } from '@/store/useApiKeyStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useGenerationQueueStore } from '@/store/useGenerationQueueStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useUILanguage } from '@/i18n/ui';
import type { NodeData, NodeType } from '@/types';
import type { CatalogModel } from '@/api/models';

/**
 * 右侧 docked 面板的默认宽度。SmartAgent 的避让计算复用同一常量，
 * 避免两边各写死一个数字后逐渐漂移。
 */
export const AI_PANEL_DOCK_WIDTH = 340;

const NODE_TYPE_LABELS: Record<NodeType, { zh: string; en: string }> = {
  text: { zh: '文本', en: 'Text' },
  image: { zh: '图片', en: 'Image' },
  video: { zh: '视频', en: 'Video' },
  audio: { zh: '音频', en: 'Audio' },
  post: { zh: '后期', en: 'Post' },
  script: { zh: '脚本', en: 'Script' },
  storyboard: { zh: '分镜', en: 'Storyboard' },
  aiapp: { zh: 'AI 应用', en: 'AI App' },
  threed: { zh: '3D', en: '3D' },
  dcc: { zh: 'DCC', en: 'DCC' },
  region: { zh: '打标签节点', en: 'Tagging Node' },
  comfyui: { zh: 'ComfyUI 工作流', en: 'ComfyUI Workflow' },
};

const SHARED_MEMORY_NODE_TYPES = new Set<NodeType>(['image', 'video', 'post']);
const MEMORY_LAYER_TITLES = {
  role: { zh: '角色记忆', en: 'Role memory' },
  brand: { zh: '品牌记忆', en: 'Brand memory' },
  style: { zh: '风格记忆', en: 'Style memory' },
  workflow: { zh: '链路记忆', en: 'Workflow memory' },
} as const;

function pushAIPanelTrace(stage: string, detail?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  const target = window as typeof window & {
    __HMDAO_AI_PANEL_TRACE__?: Array<Record<string, unknown>>;
  };
  const entries = Array.isArray(target.__HMDAO_AI_PANEL_TRACE__)
    ? target.__HMDAO_AI_PANEL_TRACE__
    : [];
  entries.push({
    stage,
    at: Date.now(),
    ...(detail || {}),
  });
  target.__HMDAO_AI_PANEL_TRACE__ = entries.slice(-120);
}

export function AIPanel() {
  return <NodeGeneratePanel />;
}

interface NodeGeneratePanelProps {
  embedded?: boolean;
  /**
   * 右侧常驻（docked）形态：挂在画布右侧而非底部浮层，与参考视频的
   * 三段式布局一致。默认 false 保持原有底部浮层行为，零回归。
   */
  docked?: boolean;
}

const AUTO_FREE_MODEL: CatalogModel = {
  id: 'auto-free',
  name: '免费优先（自动轮换）',
  provider: 'hmdao-text',
  mode: 'llm',
  nodeTypes: ['text', 'script', 'storyboard', 'aiapp'] as NodeType[],
  price: 0,
  currency: 'CNY',
  description: '自动从免费额度池择优（Seed 2.1 / Qwen3 等），主模型失败自动轮换下一个。',
  activated: false,
};

const FREE_FIRST_NODE_TYPES = new Set<NodeType>(['text', 'script', 'storyboard', 'aiapp']);

export function NodeGeneratePanel({ embedded = false, docked = false }: NodeGeneratePanelProps) {
  const { t } = useUILanguage();
  const canvas = useCanvasStore((state) => state.canvas);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const showAIPanel = useCanvasStore((state) => state.showAIPanel);
  const floatingPanel = useCanvasStore((state) => state.floatingPanel);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const apiKeys = useApiKeyStore((state) => state.keys);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const catalogItems = useModelCatalogStore((state) => state.models);
  const queueTasks = useGenerationQueueStore((state) => state.tasks);

  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [activation, setActivation] = useState<GenerationAccess | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  // 面板展开态：原来「展开」按钮是个死按钮（无 onClick），这里接上真实交互（G10）。
  const [expanded, setExpanded] = useState(false);

  const lastNodeIdRef = useRef<string | null>(null);
  const submitRunIdRef = useRef('');

  const selectedNode = useMemo(() => {
    if (!canvas || selectedNodeIds.length === 0) return null;
    return canvas.nodes.find((node) => node.id === selectedNodeIds[0]) || null;
  }, [canvas, selectedNodeIds]);

  const nodeType = selectedNode?.type as NodeType | undefined;

  const availableModels = useMemo(() => {
    if (!nodeType) return [];
    const base = catalogItems.filter((model) => (model.nodeTypes || []).includes(nodeType));
    if (FREE_FIRST_NODE_TYPES.has(nodeType)) {
      return [AUTO_FREE_MODEL, ...base];
    }
    return base;
  }, [catalogItems, nodeType]);

  useEffect(() => {
    const currentNodeId = selectedNode?.id ?? null;
    if (currentNodeId === lastNodeIdRef.current) return;
    lastNodeIdRef.current = currentNodeId;
    setPrompt(String(selectedNode?.data.prompt || ''));
    setGenError(null);
    setSelectedModelId(String(selectedNode?.data.model || availableModels[0]?.id || ''));
  }, [availableModels, selectedNode?.data.model, selectedNode?.data.prompt, selectedNode?.id]);

  useEffect(() => {
    if (!selectedModelId && availableModels[0]) {
      setSelectedModelId(availableModels[0].id);
    }
  }, [availableModels, selectedModelId]);

  const selectedModel = useMemo(
    () => availableModels.find((item) => item.id === selectedModelId) || availableModels[0] || null,
    [availableModels, selectedModelId],
  );
  const suppressedByFloatingPanel = Boolean(floatingPanel);

  // 聚合免费 provider（hmdao-*，如 auto-free）由后端免费额度分发，不需要用户 key，
  // 也不应显示「未配置 Key」角标；这里解析出真正落地的 provider 用于 key 判断。
  const authed = isAuthenticated();
  const isAggregatedFree = Boolean(selectedModel?.provider?.startsWith('hmdao-'));
  const resolvedProvider = useMemo(() => {
    if (!selectedModel || !nodeType) return selectedModel?.provider || '';
    const acc = resolveGenerationAccess(
      nodeType,
      selectedModel.id,
      selectedModel.provider,
      apiKeys,
      authed,
      Boolean(selectedModel?.activated) || isAggregatedFree,
    );
    return acc.provider || selectedModel.provider;
  }, [selectedModel, nodeType, apiKeys, authed, selectedModel?.activated, isAggregatedFree]);

  const activeKey = selectedModel ? apiKeys[resolvedProvider] : undefined;
  // 任务 AL：invalid 与 expired 同为不可用，避免被吊销的 key 在面板显示「已激活」。
  const hasUsableActiveKey = Boolean(activeKey && !isUnusableProviderKeyStatus(activeKey.status) && (activeKey.apiKey || activeKey.metadataOnly));
  const selectedModelActivated = Boolean(
    selectedModel?.activated || hasUsableActiveKey,
  );
  const activeKeyLabel = activeKey?.maskedKey || selectedModel?.maskedKey || '';

  const currentParams = selectedNode?.data?.params && typeof selectedNode.data.params === 'object'
    ? selectedNode.data.params as Record<string, unknown>
    : {};
  const appliedMemoryIds = Array.isArray(currentParams.sharedMemoryIds)
    ? currentParams.sharedMemoryIds.map((item) => String(item || '')).filter(Boolean)
    : [];
  const generationProgress = Array.isArray(currentParams.generationProgress) ? currentParams.generationProgress : [];
  const latestProgress = generationProgress.length > 0
    ? generationProgress[generationProgress.length - 1] as Record<string, unknown>
    : null;
  const lastErrorCategory = typeof currentParams.lastErrorCategory === 'string' ? currentParams.lastErrorCategory : '';
  const sharedMemorySuggestions = useMemo(() => {
    if (!nodeType || !SHARED_MEMORY_NODE_TYPES.has(nodeType)) {
      return { grouped: [], ranked: [] };
    }
    return getSharedMemorySuggestions({
      prompt: prompt.trim() || String(selectedNode?.data.prompt || ''),
      nodeType,
      limit: 8,
    });
  }, [nodeType, prompt, selectedNode?.data.prompt]);

  const handleApplySharedMemory = useCallback((memory: SharedAgentMemory) => {
    if (!selectedNode) return;
    const layerTitle = MEMORY_LAYER_TITLES[memory.layer];
    const prefix = layerTitle ? t(layerTitle.zh, layerTitle.en) : t('共享记忆', 'Shared memory');
    const contextLine = `[${prefix}] ${memory.summary}`;
    const basePrompt = prompt.trim() || String(selectedNode.data.prompt || '').trim();
    const nextPrompt = basePrompt.includes(contextLine)
      ? basePrompt
      : basePrompt
        ? `${basePrompt}\n${contextLine}`
        : contextLine;
    const nextMemoryIds = Array.from(new Set([...appliedMemoryIds, memory.id]));

    setPrompt(nextPrompt);
    updateNodeData(selectedNode.id, {
      ...selectedNode.data,
      prompt: nextPrompt,
      params: {
        ...currentParams,
        sharedMemoryIds: nextMemoryIds,
        sharedMemoryLayers: Array.from(new Set([
          ...(Array.isArray(currentParams.sharedMemoryLayers) ? currentParams.sharedMemoryLayers.map((item) => String(item || '')) : []),
          memory.layer,
        ])),
        sharedMemoryContext: Array.from(new Set([
          ...(Array.isArray(currentParams.sharedMemoryContext) ? currentParams.sharedMemoryContext.map((item) => String(item || '')) : []),
          contextLine,
        ])).slice(0, 8),
      },
    });
  }, [appliedMemoryIds, currentParams, prompt, selectedNode, t, updateNodeData]);

  const handleGenerate = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!selectedNode || !nodeType || !trimmedPrompt || isGenerating || !selectedModel) return;

    const access = resolveGenerationAccess(
      nodeType,
      selectedModel.id,
      selectedModel.provider,
      apiKeys,
      authed,
      isAggregatedFree || selectedModelActivated,
    );
    if (!access.ok) {
      if (access.reason === 'auth') {
        window.location.href = '/login';
        return;
      }
      setActivation(access);
      return;
    }

    setIsGenerating(true);
    setGenError(null);

    // 入队：让右侧 docked 面板的进度卡与左下占位卡能实时反映这个任务（G07 / G09）。
    const queueTaskId = useGenerationQueueStore.getState().enqueue({
      nodeId: selectedNode.id,
      label: trimmedPrompt.length > 24 ? `${trimmedPrompt.slice(0, 24)}…` : trimmedPrompt,
    });
    useGenerationQueueStore.getState().markRunning(queueTaskId);

    const runId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    submitRunIdRef.current = runId;

    const nextParams = {
      ...(selectedNode.data.params || {}),
      activeRunId: runId,
      generationProgress: [],
      lastError: undefined,
      lastErrorCategory: undefined,
      lastErrorStage: undefined,
    };

    pushAIPanelTrace('submit:before-update-node', {
      nodeId: selectedNode.id,
      runId,
      provider: access.provider,
      model: selectedModel.id,
    });
    try {
      updateNodeData(selectedNode.id, {
        ...selectedNode.data,
        prompt: trimmedPrompt,
        provider: access.provider,
        model: selectedModel.id,
        status: 'generating',
        error: undefined,
        params: nextParams,
      });
      pushAIPanelTrace('submit:after-update-node', {
        nodeId: selectedNode.id,
        runId,
      });
    } catch (error) {
      pushAIPanelTrace('submit:update-node-error', {
        nodeId: selectedNode.id,
        runId,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : '',
      });
      throw error;
    }

    try {
      pushAIPanelTrace('submit:before-generate-call', {
        nodeId: selectedNode.id,
        runId,
      });
      const result = await generateNodeOutputWithFallback({
        nodeId: selectedNode.id,
        nodeType,
        prompt: trimmedPrompt,
        provider: access.provider,
        apiKey: access.apiKey || '',
        baseUrl: access.endpoint,
        model: selectedModel.id,
        data: {
          ...(selectedNode.data as NodeData),
          prompt: trimmedPrompt,
          provider: access.provider,
          model: selectedModel.id,
          status: 'generating',
          params: nextParams,
        },
      });
      pushAIPanelTrace('submit:after-generate-call', {
        nodeId: selectedNode.id,
        runId,
        status: typeof result.status === 'string' ? result.status : '',
      });

      const latestNode = useCanvasStore.getState().getNodeById(selectedNode.id);
      const latestRunId = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? (latestNode.data.params as Record<string, unknown>).activeRunId
        : undefined;
      if (latestRunId !== runId || submitRunIdRef.current !== runId) return;

      updateNodeData(selectedNode.id, result);
      setPrompt('');
      useGenerationQueueStore.getState().markSuccess(queueTaskId);
    } catch (error) {
      pushAIPanelTrace('submit:catch', {
        nodeId: selectedNode.id,
        runId,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : '',
      });
      const latestNode = useCanvasStore.getState().getNodeById(selectedNode.id);
      const latestRunId = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? (latestNode.data.params as Record<string, unknown>).activeRunId
        : undefined;
      if (latestRunId !== runId || submitRunIdRef.current !== runId) return;

      const generationError = error instanceof GenerationError ? error : null;
      const message = describeGenerationError(error);
      setGenError(message);
      useGenerationQueueStore.getState().markFailed(queueTaskId, message);
      updateNodeData(selectedNode.id, {
        status: 'error',
        error: message,
        params: {
          ...nextParams,
          generationProgress: generationError?.metadata.workflowProgress || [],
          lastError: message,
          lastErrorCategory: generationError?.metadata.category || 'request',
          lastErrorStage: generationError?.metadata.stage,
          lastRequestId: generationError?.metadata.requestId,
          failedAt: Date.now(),
        },
      });
    } finally {
      // 提前 return 的分支（例如 runId 不匹配、被更新的运行取代）也要收尾，
      // 否则任务会永远停在 running，进度卡与左下占位卡无法归零。
      const queue = useGenerationQueueStore.getState();
      const task = queue.tasks.find((item) => item.id === queueTaskId);
      if (task && task.status === 'running') queue.markFailed(queueTaskId, '已取消');
      setIsGenerating(false);
    }
  }, [apiKeys, authed, isAggregatedFree, isGenerating, nodeType, prompt, selectedModel, selectedNode, updateNodeData]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleGenerate();
    }
  }, [handleGenerate]);

  if (!embedded && !showAIPanel) return null;

  const shell = (
    <div
      className={
        docked
          ? 'flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border border-[#30363d] bg-[#161b22]/95 shadow-2xl backdrop-blur-xl'
          : 'overflow-hidden rounded-lg border border-[#30363d] bg-[#161b22]/95 shadow-2xl backdrop-blur-xl'
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[#21262d] px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <select
            value={selectedModelId}
            onChange={(event) => setSelectedModelId(event.target.value)}
            data-testid={embedded ? 'smart-agent-model-select' : 'ai-panel-model-select'}
            className="min-w-[220px] flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 text-xs text-[#c9d1d9] outline-none focus:border-[#00d4aa]"
            aria-label={t('选择模型', 'Select model')}
          >
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>

          {selectedModelActivated ? <span className="text-xs text-emerald-400">{t('已激活', 'Activated')}</span> : null}
          {selectedModel?.discountLabel ? (
            <span className="rounded-full bg-amber-500/10 px-2 py-1 text-xs text-amber-300">{selectedModel.discountLabel}</span>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs">
          {activeKeyLabel ? (
            <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-300">{t('已激活', 'Activated')} {activeKeyLabel}</span>
          ) : isAggregatedFree ? (
            <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-300">🆓 {t('免费额度', 'Free quota')}</span>
          ) : (
            <Link
              to="/settings/api-keys"
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-amber-300 hover:bg-amber-500/20"
            >
              <KeyRound className="h-3 w-3" />
              {t('未配置 Key', 'No Key')}
            </Link>
          )}
          {!embedded ? (
            <button
              type="button"
              data-testid="ai-panel-expand-toggle"
              onClick={() => setExpanded((value) => !value)}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0d1117] text-[#8b949e] hover:text-white"
              title={expanded ? t('收起', 'Collapse') : t('展开', 'Expand')}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
      </div>

      {queueTasks.length > 0 ? (
        <div
          className="border-b border-[#21262d] px-4 py-3"
          data-testid={embedded ? 'smart-agent-generation-queue' : 'ai-panel-generation-queue'}
        >
          <GenerationProgressCard />
          <div className="mt-2.5 space-y-1.5">
            {queueTasks.map((task, index) => (
              <GenerationResultCard
                key={task.id}
                index={index}
                label={task.label}
                status={task.status}
                error={task.error}
                onClick={task.nodeId ? () => setSelectedNodeIds([task.nodeId as string]) : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="px-4 py-3">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          data-testid={embedded ? 'smart-agent-prompt' : 'ai-panel-prompt'}
          placeholder={selectedNode
            ? t('输入提示词，按 Enter 生成，Shift+Enter 换行', 'Enter a prompt, press Enter to generate, Shift+Enter for a new line')
            : t('请先在画布中选中一个节点', 'Select a node on the canvas first')}
          rows={embedded ? 5 : 3}
          onKeyDown={handleKeyDown}
          disabled={!selectedNode}
          className="w-full resize-none rounded-lg border border-[#30363d] bg-[#0d1117] p-3 text-sm text-[#e6edf3] outline-none placeholder:text-[#484f58] focus:border-[#00d4aa] disabled:opacity-60"
        />
      </div>

      {nodeType && SHARED_MEMORY_NODE_TYPES.has(nodeType) ? (
        <div className="border-t border-[#21262d] px-4 py-3" data-testid={embedded ? 'smart-agent-memory-suggestions' : 'ai-panel-memory-suggestions'}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-[#e6edf3]">{t('共享记忆检索', 'Shared memory retrieval')}</div>
            <div className="text-[11px] text-[#6e7681]">{t('角色 / 品牌 / 风格 / 链路', 'Role / Brand / Style / Workflow')}</div>
          </div>
          {sharedMemorySuggestions.grouped.length ? (
            <div className="mt-3 space-y-3">
              {sharedMemorySuggestions.grouped.map((group) => {
                const label = MEMORY_LAYER_TITLES[group.layer];
                return (
                  <div key={group.layer} className="space-y-2">
                    <div className="text-[11px] font-medium text-[#8b949e]">{t(label.zh, label.en)}</div>
                    <div className="space-y-2">
                      {group.items.map(({ memory, reason }, index) => {
                        const applied = appliedMemoryIds.includes(memory.id);
                        return (
                          <div
                            key={memory.id}
                            data-testid={`${embedded ? 'smart-agent' : 'ai-panel'}-memory-item-${group.layer}-${index}`}
                            className="rounded-lg border border-[#30363d] bg-[#0d1117]/70 px-3 py-2"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-[#e6edf3]">{memory.title}</div>
                                <div className="mt-1 text-[11px] leading-5 text-[#8b949e]">{memory.summary}</div>
                                <div className="mt-1 text-[10px] text-[#6e7681]">{reason}</div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleApplySharedMemory(memory)}
                                data-testid={`${embedded ? 'smart-agent' : 'ai-panel'}-memory-apply-${group.layer}-${index}`}
                                className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                  applied
                                    ? 'bg-emerald-500/15 text-emerald-300'
                                    : 'bg-[#1a8cff]/15 text-[#7cc4ff] hover:bg-[#1a8cff]/25'
                                }`}
                              >
                                {applied ? t('已应用', 'Applied') : t('应用', 'Apply')}
                              </button>
                            </div>
                            {memory.tags.length ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {memory.tags.slice(0, 5).map((tag) => (
                                  <span key={`${memory.id}-${tag}`} className="rounded-full bg-[#20262f] px-2 py-0.5 text-[10px] text-[#9ab0c2]">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-[#30363d] px-3 py-2 text-[11px] leading-5 text-[#6e7681]">
              {t('当前还没有可复用的共享记忆。先在智能机器人里完成一次交付，后续图片、视频和后期节点就会开始共用这些记忆。', 'No reusable shared memory yet. Complete one delivery in Smart Agent first, then image, video, and post nodes can reuse it here.')}
            </div>
          )}
        </div>
      ) : null}

      {genError ? (
        <div className="flex items-center gap-2 border-t border-[#f85149]/30 bg-[#490202]/60 px-4 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[#f85149]" />
          <span className="text-xs text-[#f85149]">{genError}</span>
          <button
            type="button"
            onClick={() => setGenError(null)}
            className="ml-auto text-xs text-[#8b949e] hover:text-white"
          >
            {t('关闭', 'Close')}
          </button>
        </div>
      ) : null}

      {genError ? (
        <div className="px-4 pb-2">
          <ErrorDetailBlock category={lastErrorCategory} message={genError} />
        </div>
      ) : null}

      {isGenerating && latestProgress ? (
        <div className="border-t border-[#21262d] px-4 py-2">
          <ProgressBadge
            label={String(latestProgress.message || latestProgress.stage || t('处理中', 'Processing'))}
            progress={Number(latestProgress.progress)}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-[#21262d] px-4 py-2.5">
        <span className="text-xs text-[#8b949e]">
          {selectedNode
            ? `${t(NODE_TYPE_LABELS[selectedNode.type as NodeType]?.zh || '节点', NODE_TYPE_LABELS[selectedNode.type as NodeType]?.en || 'Node')} ${t('节点', 'node')}`
            : t('未选中节点', 'No node selected')}
        </span>
        <div className="flex-1" />
        {selectedModel?.price ? (
          <span className="text-xs font-medium text-[#00d4aa]">
            {selectedModel.currency || 'CNY'} {selectedModel.price}
          </span>
        ) : null}
        <button
          type="button"
          disabled={isGenerating || !prompt.trim() || !selectedNode || !selectedModel}
          onClick={() => void handleGenerate()}
          data-testid={embedded ? 'smart-agent-generate' : 'ai-panel-generate'}
          className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-all ${
            isGenerating || !prompt.trim() || !selectedNode || !selectedModel
              ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
              : 'bg-[#00d4aa] text-[#0d1117] hover:bg-[#00e5b3]'
          }`}
        >
          {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {isGenerating ? t('生成中', 'Generating') : t('生成', 'Generate')}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {embedded ? (
        <div data-testid="smart-agent-generate-panel" className="w-full">
          {shell}
        </div>
      ) : docked ? (
        // 右侧常驻（G05）：与参考视频一致的三段式布局，不再用底部居中浮层。
        <div
          data-testid="ai-panel-docked"
          style={{ width: expanded ? AI_PANEL_DOCK_WIDTH + 220 : AI_PANEL_DOCK_WIDTH }}
          className="hmdao-ai-dock-in pointer-events-auto absolute bottom-4 right-4 top-4 z-[60] flex max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col transition-[width] duration-200 ease-out"
        >
          {shell}
        </div>
      ) : (
        <div
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 transition-all duration-150 ${
            expanded ? 'w-[min(980px,calc(100vw-32px))]' : 'w-[min(680px,calc(100vw-32px))]'
          } ${
            suppressedByFloatingPanel ? 'pointer-events-none z-20 opacity-35' : 'z-30 opacity-100'
          }`}
        >
          {shell}
        </div>
      )}

      <ModelActivationPrompt
        open={Boolean(activation)}
        mode={activation?.mode || 'llm'}
        provider={activation?.provider || selectedModel?.provider || 'deepseek'}
        reason={activation?.reason || 'api-key'}
        onClose={() => setActivation(null)}
      />
    </>
  );
}

