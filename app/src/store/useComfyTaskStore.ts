// ComfyUI 节点实时进度 store：执行器写入，ComfyUiNode 订阅渲染。
// key 为节点标识（canvas 节点 id 或执行器 nodeId），由 run 触发方通过
// WorkflowStep.data.params.comfyNodeId 关联，缺省时回退到执行器 nodeId。
import { create } from 'zustand';

export type ComfyTaskPhase = 'idle' | 'queued' | 'running' | 'done' | 'error';

export interface ComfyTaskState {
  phase: ComfyTaskPhase;
  percent: number; // 0-100
  currentNode: string | null;
  stepLabel: string; // 如 "节点 12: 45/100"
  outputs: Array<{ type?: string; url: string }>;
  error: string | null;
  updatedAt: number;
}

interface ComfyTaskStore {
  tasks: Record<string, ComfyTaskState>;
  set: (nodeKey: string, patch: Partial<ComfyTaskState>) => void;
  clear: (nodeKey: string) => void;
}

const EMPTY: ComfyTaskState = {
  phase: 'idle',
  percent: 0,
  currentNode: null,
  stepLabel: '',
  outputs: [],
  error: null,
  updatedAt: 0,
};

export const useComfyTaskStore = create<ComfyTaskStore>((set) => ({
  tasks: {},
  set: (nodeKey, patch) =>
    set((st) => ({
      tasks: {
        ...st.tasks,
        [nodeKey]: { ...(st.tasks[nodeKey] || EMPTY), ...patch, updatedAt: Date.now() },
      },
    })),
  clear: (nodeKey) =>
    set((st) => {
      const next = { ...st.tasks };
      delete next[nodeKey];
      return { tasks: next };
    }),
}));
