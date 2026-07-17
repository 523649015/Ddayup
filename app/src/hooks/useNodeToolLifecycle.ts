import { useCallback } from 'react';
import type { NodeData } from '@/types';

type ToolConfig = Record<string, unknown>;

type LifecycleProgress = {
  progress: number;
  message: string;
  stage?: string;
};

type UpdateNodeData = (nodeId: string, data: Partial<NodeData>) => void;

type UseNodeToolLifecycleOptions<Tool extends string> = {
  nodeId: string;
  updateNodeData: UpdateNodeData;
  buildParams: (tool: Tool, config: ToolConfig, extra?: ToolConfig) => ToolConfig;
  defaultStagePrefix?: string;
};

type SetGeneratingOptions = {
  progress: LifecycleProgress['progress'] | LifecycleProgress;
  message?: string;
  stage?: string;
  params?: ToolConfig;
  nodeData?: Partial<NodeData>;
};

type FinalizeOptions = {
  status: 'completed' | 'error';
  error?: string;
  showNodeError?: boolean;
  errorCategory?: string;
  errorStage?: string;
  params?: ToolConfig;
  nodeData?: Partial<NodeData>;
};

type RollbackOptions = {
  status?: NodeData['status'];
  clearNodeError?: boolean;
  params?: ToolConfig;
  nodeData?: Partial<NodeData>;
};

function buildDefaultStage<Tool extends string>(tool: Tool, prefix: string, stage?: string) {
  return stage || `${prefix}${tool}`;
}

function normalizeLifecycleProgress(
  value: SetGeneratingOptions['progress'],
  message?: string,
  stage?: string,
): LifecycleProgress {
  if (typeof value === 'number') {
    return {
      progress: value,
      message: message || '',
      stage,
    };
  }
  return value;
}

export function useNodeToolLifecycle<Tool extends string>(
  options: UseNodeToolLifecycleOptions<Tool>,
) {
  const {
    nodeId,
    updateNodeData,
    buildParams,
    defaultStagePrefix = 'local-',
  } = options;

  const setGenerating = useCallback((tool: Tool, config: ToolConfig, next: SetGeneratingOptions) => {
    const progress = normalizeLifecycleProgress(next.progress, next.message, next.stage);
    updateNodeData(nodeId, {
      ...(next.nodeData || {}),
      status: 'generating',
      params: buildParams(tool, config, {
        generationProgress: [{
          progress: progress.progress,
          message: progress.message,
          stage: buildDefaultStage(tool, defaultStagePrefix, progress.stage),
        }],
        ...(next.params || {}),
      }),
    });
  }, [buildParams, defaultStagePrefix, nodeId, updateNodeData]);

  const finalize = useCallback((tool: Tool, config: ToolConfig, next: FinalizeOptions) => {
    const errorMessage = String(next.error || '').trim();
    const errorCategory = next.errorCategory || `${defaultStagePrefix}${tool}`.replace(/-$/, '');
    const errorStage = buildDefaultStage(tool, defaultStagePrefix, next.errorStage);
    const shouldShowNodeError = next.showNodeError ?? next.status === 'error';

    updateNodeData(nodeId, {
      ...(next.nodeData || {}),
      status: next.status,
      error: shouldShowNodeError ? errorMessage : undefined,
      params: buildParams(tool, config, {
        generationProgress: [],
        ...(next.status === 'completed'
          ? {
              lastError: '',
              lastErrorCategory: '',
              lastErrorStage: '',
            }
          : {
              lastError: errorMessage,
              lastErrorCategory: errorCategory,
              lastErrorStage: errorStage,
            }),
        ...(next.params || {}),
      }),
    });
  }, [buildParams, defaultStagePrefix, nodeId, updateNodeData]);

  const complete = useCallback((tool: Tool, config: ToolConfig, next: Omit<FinalizeOptions, 'status'> = {}) => {
    finalize(tool, config, {
      ...next,
      status: 'completed',
    });
  }, [finalize]);

  const fail = useCallback((tool: Tool, config: ToolConfig, next: Omit<FinalizeOptions, 'status'>) => {
    finalize(tool, config, {
      ...next,
      status: 'error',
    });
  }, [finalize]);

  const rollback = useCallback((tool: Tool, config: ToolConfig, next: RollbackOptions = {}) => {
    updateNodeData(nodeId, {
      ...(next.nodeData || {}),
      status: next.status ?? 'idle',
      ...(next.clearNodeError === false ? {} : { error: '' }),
      params: buildParams(tool, config, {
        generationProgress: [],
        lastError: '',
        lastErrorCategory: '',
        lastErrorStage: '',
        ...(next.params || {}),
      }),
    });
  }, [buildParams, nodeId, updateNodeData]);

  return {
    setGenerating,
    finalize,
    complete,
    fail,
    rollback,
  };
}
