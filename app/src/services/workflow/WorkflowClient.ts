import type { NodeType } from '@/types';

export interface WorkflowNodeRequest {
  node_id: string;
  nodeType: NodeType;
  provider: string;
  model: string;
  prompt: string;
  endpoint: string;
  baseUrl?: string;
  body: Record<string, unknown>;
  apiKey?: string;
  timeout?: number;
  depends_on?: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id?: string;
  name?: string;
  nodes: WorkflowNodeRequest[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowSocketEnvelope<T = Record<string, unknown>> {
  msg_id?: string;
  msg_type: string;
  payload: T;
  ts?: number;
}

export interface WorkflowNodeResult {
  node_id: string;
  nodeType: NodeType;
  provider: string;
  model: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  content?: string;
  asset?: {
    id?: string;
    type?: 'image' | 'video' | 'audio' | 'text';
    url?: string;
    kind?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  };
  assets?: Array<{
    id?: string;
    type?: 'image' | 'video' | 'audio' | 'text';
    url?: string;
    kind?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  }>;
  error?: {
    message?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface WorkflowStatusPayload {
  workflow_id: string;
  request_id?: string;
  status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';
  name?: string;
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
  progress: number;
  created_at?: number;
  updated_at?: number;
  node_results?: WorkflowNodeResult[];
  error?: string;
}

export interface WorkflowRunResult {
  workflowId: string;
  status: WorkflowStatusPayload['status'];
  nodeResults: WorkflowNodeResult[];
  progress: number;
  error?: string;
  progressLog?: WorkflowProgressSnapshot[];
}

interface ActiveWorkflow {
  requestId: string;
  workflowId?: string;
  createdAt: number;
  timeoutMs: number;
  acceptTimeoutHandle: number | null;
  executionTimeoutHandle: number | null;
  acceptedAt?: number;
  onEvent?: (event: WorkflowSocketEnvelope) => void;
  progressLog: WorkflowProgressSnapshot[];
  resolve: (result: WorkflowRunResult) => void;
  reject: (error: Error) => void;
}

export interface WorkflowRunOptions {
  timeoutMs?: number;
  acceptTimeoutMs?: number;
  onEvent?: (event: WorkflowSocketEnvelope) => void;
}

export interface WorkflowProgressSnapshot {
  workflowId?: string;
  requestId?: string;
  nodeId?: string;
  stage: 'queued' | 'started' | 'running' | 'uploading' | 'rendering' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  message?: string;
  status?: WorkflowStatusPayload['status'];
}

export interface WorkflowClientConfig {
  url?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
  debug?: boolean;
}

const DEFAULT_CONFIG: Required<WorkflowClientConfig> = {
  url: '',
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 10_000,
  reconnectInitialDelayMs: 800,
  reconnectMaxDelayMs: 10_000,
  connectTimeoutMs: 8_000,
  debug: false,
};

let singleton: WorkflowClient | null = null;

function buildDefaultUrl() {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8792/ws/workflow';
  const explicitUrl = import.meta.env.VITE_HMDAO_WORKFLOW_WS_URL || (window as typeof window & {
    __HMDAO_WORKFLOW_WS_URL__?: string;
  }).__HMDAO_WORKFLOW_WS_URL__;
  if (explicitUrl) return explicitUrl;
  const url = new URL(window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/workflow';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function nextId(prefix: string) {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export class WorkflowClient {
  private config: Required<WorkflowClientConfig>;
  private ws: WebSocket | null = null;
  private state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' = 'idle';
  private connectPromise: Promise<void> | null = null;
  private heartbeatTimer: number | null = null;
  private heartbeatTimeoutTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private activeByRequestId = new Map<string, ActiveWorkflow>();
  private activeByWorkflowId = new Map<string, ActiveWorkflow>();
  private statusWaiters = new Map<string, { resolve: (status: WorkflowStatusPayload) => void; reject: (error: Error) => void; timeout: number }>();

  constructor(config: WorkflowClientConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      url: config.url || buildDefaultUrl(),
    };
  }

  static getInstance(config?: WorkflowClientConfig) {
    if (!singleton) singleton = new WorkflowClient(config);
    return singleton;
  }

  getState() {
    return this.state;
  }

  isConnected() {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    if (this.state === 'closed') {
      this.intentionalClose = false;
      this.state = 'idle';
    }

    this.state = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.url);
      let settled = false;
      let opened = false;
      let connectError: Error | null = null;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (this.ws === ws) this.ws = null;
        this.stopHeartbeat();
        this.connectPromise = null;
        reject(error);
      };

      const timeout = window.setTimeout(() => {
        connectError = new Error(`Workflow WebSocket 连接超时 (${this.config.connectTimeoutMs}ms)`);
        try { ws.close(); } catch { /* noop */ }
        fail(connectError);
      }, this.config.connectTimeoutMs);

      ws.onopen = () => {
        if (settled) return;
        opened = true;
        window.clearTimeout(timeout);
        this.ws = ws;
        this.state = 'connected';
        this.connectPromise = null;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.resetHeartbeatTimeout();
        this.log('connected');
        this.restoreActiveWorkflows();
        settled = true;
        resolve();
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      ws.onerror = (event) => {
        this.log('socket error', event);
        if (!opened && !connectError) {
          connectError = new Error('Workflow WebSocket 连接失败。');
        }
      };

      ws.onclose = (event) => {
        window.clearTimeout(timeout);
        const wasActive = this.ws === ws;
        if (wasActive) this.ws = null;
        this.stopHeartbeat();
        this.connectPromise = null;
        if (!opened) {
          fail(connectError || new Error(`Workflow WebSocket 在握手完成前关闭 (${event.code})`));
          return;
        }
        if (this.intentionalClose) {
          this.state = 'closed';
          return;
        }
        this.state = 'reconnecting';
        this.scheduleReconnect();
      };
    }).catch((error) => {
      this.connectPromise = null;
      if (!this.intentionalClose) {
        this.state = 'reconnecting';
        this.scheduleReconnect();
      }
      throw error;
    });

    return this.connectPromise;
  }

  disconnect() {
    this.intentionalClose = true;
    this.state = 'closed';
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'client closing'); } catch { /* noop */ }
      this.ws = null;
    }
  }

  async runWorkflow(workflow: WorkflowDefinition, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
    await this.connect();

    const requestId = nextId('wfreq');
    const timeoutMs = options.timeoutMs ?? 180_000;
    const acceptTimeoutMs = options.acceptTimeoutMs ?? Math.min(Math.max(this.config.connectTimeoutMs * 2, 6_000), 12_000);

    return new Promise<WorkflowRunResult>((resolve, reject) => {
        const acceptTimeoutHandle = window.setTimeout(() => {
        const active = this.activeByRequestId.get(requestId);
        if (!active) return;
        this.activeByRequestId.delete(requestId);
        if (active.workflowId) this.activeByWorkflowId.delete(active.workflowId);
        reject(new Error(`工作流受理超时 (${acceptTimeoutMs}ms)`));
      }, acceptTimeoutMs);

      const active: ActiveWorkflow = {
        requestId,
        createdAt: Date.now(),
        timeoutMs,
        acceptTimeoutHandle,
        executionTimeoutHandle: null,
        onEvent: options.onEvent,
        progressLog: [{
          requestId,
          stage: 'queued',
          progress: 0,
          message: 'Workflow queued.',
          status: 'accepted',
        }],
        resolve,
        reject,
      };

      this.activeByRequestId.set(requestId, active);
      try {
        this.send({
          msg_id: requestId,
          msg_type: 'workflow:create',
          payload: { workflow },
        });
      } catch (error) {
        this.finishActive(active, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async queryStatus(workflowId: string, timeoutMs = 12_000): Promise<WorkflowStatusPayload> {
    await this.connect();
    const requestId = nextId('wfstatus');
    return new Promise<WorkflowStatusPayload>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.statusWaiters.delete(requestId);
        reject(new Error(`查询工作流状态超时: ${workflowId}`));
      }, timeoutMs);
      this.statusWaiters.set(requestId, { resolve, reject, timeout });
      this.send({
        msg_id: requestId,
        msg_type: 'status:query',
        payload: { workflow_id: workflowId, subscribe: true },
      });
    });
  }

  async cancelWorkflow(workflowId: string): Promise<void> {
    await this.connect();
    this.send({
      msg_id: nextId('wfcancel'),
      msg_type: 'workflow:control',
      payload: {
        workflow_id: workflowId,
        action: 'cancel',
      },
    });
  }

  private send(message: WorkflowSocketEnvelope) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Workflow WebSocket 未连接');
    }
    this.ws.send(JSON.stringify(message));
  }

  private handleMessage(raw: string | ArrayBuffer | Blob) {
    if (typeof raw !== 'string') return;
    let message: WorkflowSocketEnvelope;
    try {
      message = JSON.parse(raw) as WorkflowSocketEnvelope;
    } catch {
      this.log('message parse failed');
      return;
    }

    if (message.msg_type === 'pong') return;
    this.resetHeartbeatTimeout();
    if (message.msg_type === 'error') {
      const payload = message.payload as Record<string, unknown>;
      const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
      const workflowId = typeof payload.workflow_id === 'string' ? payload.workflow_id : '';
      const active = (requestId && this.activeByRequestId.get(requestId)) || (workflowId && this.activeByWorkflowId.get(workflowId));
      if (active) {
        this.finishActive(active, new Error(String(payload.error || payload.message || '工作流执行失败')));
      }
      const waiter = requestId ? this.statusWaiters.get(requestId) : undefined;
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.statusWaiters.delete(requestId);
        waiter.reject(new Error(String(payload.error || payload.message || '工作流状态查询失败')));
      }
      return;
    }

    if (message.msg_type === 'status:result') {
      const requestId = message.msg_id || '';
      const waiter = this.statusWaiters.get(requestId);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.statusWaiters.delete(requestId);
        waiter.resolve(message.payload as unknown as WorkflowStatusPayload);
      }
      return;
    }

    const payload = message.payload as Record<string, unknown>;
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
    const workflowId = typeof payload.workflow_id === 'string' ? payload.workflow_id : '';

    if (message.msg_type === 'workflow:accepted' && requestId) {
      const active = this.activeByRequestId.get(requestId);
      if (active && workflowId) {
        if (active.acceptTimeoutHandle) {
          clearTimeout(active.acceptTimeoutHandle);
          active.acceptTimeoutHandle = null;
        }
        if (!active.executionTimeoutHandle) {
          active.acceptedAt = Date.now();
          active.executionTimeoutHandle = window.setTimeout(() => {
            const current = this.activeByRequestId.get(requestId);
            if (!current) return;
            this.finishActive(current, new Error(`工作流执行超时 (${current.timeoutMs}ms)`));
          }, active.timeoutMs);
        }
        active.workflowId = workflowId;
        this.activeByWorkflowId.set(workflowId, active);
        this.pushProgress(active, {
          workflowId,
          requestId,
          stage: 'queued',
          progress: 0,
          message: 'Workflow accepted.',
          status: 'accepted',
        });
      }
    }

    const active: ActiveWorkflow | undefined = (workflowId ? this.activeByWorkflowId.get(workflowId) : undefined)
      || (requestId ? this.activeByRequestId.get(requestId) : undefined);
    active?.onEvent?.(message);
    if (active) {
      this.ingestProgressEvent(active, message);
    }

    if (message.msg_type === 'workflow:completed' || message.msg_type === 'workflow:failed' || message.msg_type === 'workflow:cancelled') {
      const statusPayload = message.payload as unknown as WorkflowStatusPayload;
      const target = active || (workflowId ? this.activeByWorkflowId.get(workflowId) : undefined);
      if (!target) return;
      if (message.msg_type === 'workflow:completed') {
        this.finishActive(target, {
          workflowId: statusPayload.workflow_id,
          status: statusPayload.status,
          progress: statusPayload.progress,
          nodeResults: statusPayload.node_results || [],
          error: statusPayload.error,
          progressLog: [...target.progressLog],
        });
        return;
      }
      this.finishActive(target, new Error(statusPayload.error || (message.msg_type === 'workflow:cancelled' ? '工作流已取消' : '工作流执行失败')));
    }
  }

  private finishActive(active: ActiveWorkflow, outcome: WorkflowRunResult | Error) {
    if (active.acceptTimeoutHandle) {
      clearTimeout(active.acceptTimeoutHandle);
      active.acceptTimeoutHandle = null;
    }
    if (active.executionTimeoutHandle) {
      clearTimeout(active.executionTimeoutHandle);
      active.executionTimeoutHandle = null;
    }
    this.activeByRequestId.delete(active.requestId);
    if (active.workflowId) this.activeByWorkflowId.delete(active.workflowId);

    if (outcome instanceof Error) {
      active.reject(outcome);
      return;
    }
    active.resolve(outcome);
  }

  private pushProgress(active: ActiveWorkflow, snapshot: WorkflowProgressSnapshot) {
    const previous = active.progressLog[active.progressLog.length - 1];
    if (
      previous &&
      previous.stage === snapshot.stage &&
      previous.progress === snapshot.progress &&
      previous.message === snapshot.message &&
      previous.nodeId === snapshot.nodeId
    ) {
      return;
    }
    active.progressLog.push(snapshot);
  }

  private ingestProgressEvent(active: ActiveWorkflow, message: WorkflowSocketEnvelope) {
    const payload = message.payload as Partial<WorkflowStatusPayload> & { node_id?: string; error?: string };
    const workflowId = typeof payload.workflow_id === 'string' ? payload.workflow_id : active.workflowId;
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : active.requestId;
    const nodeId = typeof payload.node_id === 'string' ? payload.node_id : undefined;
    const progress = Number.isFinite(Number(payload.progress)) ? Number(payload.progress) : undefined;

    if (message.msg_type === 'workflow:started') {
      this.pushProgress(active, { workflowId, requestId, stage: 'started', progress: progress ?? 0, message: 'Workflow started.', status: 'running' });
      return;
    }
    if (message.msg_type === 'node:started') {
      this.pushProgress(active, { workflowId, requestId, nodeId, stage: 'running', progress, message: `Node ${nodeId || ''} started.`.trim(), status: 'running' });
      return;
    }
    if (message.msg_type === 'node:completed') {
      this.pushProgress(active, { workflowId, requestId, nodeId, stage: 'rendering', progress, message: `Node ${nodeId || ''} completed.`.trim(), status: 'running' });
      return;
    }
    if (message.msg_type === 'node:failed') {
      this.pushProgress(active, { workflowId, requestId, nodeId, stage: 'failed', progress, message: payload.error || 'Node execution failed.', status: 'failed' });
      return;
    }
    if (message.msg_type === 'workflow:completed') {
      this.pushProgress(active, { workflowId, requestId, stage: 'completed', progress: 100, message: 'Workflow completed.', status: 'completed' });
      return;
    }
    if (message.msg_type === 'workflow:failed') {
      this.pushProgress(active, { workflowId, requestId, stage: 'failed', progress, message: payload.error || 'Workflow failed.', status: 'failed' });
      return;
    }
    if (message.msg_type === 'workflow:cancelled') {
      this.pushProgress(active, { workflowId, requestId, stage: 'cancelled', progress, message: 'Workflow cancelled.', status: 'cancelled' });
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({
        msg_id: nextId('ping'),
        msg_type: 'ping',
        payload: {},
        ts: Date.now(),
      }));
      this.resetHeartbeatTimeout();
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private resetHeartbeatTimeout() {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
    }
    this.heartbeatTimeoutTimer = window.setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.log('heartbeat timeout, closing socket');
      try {
        this.ws.close(4001, 'heartbeat timeout');
      } catch {
        // noop
      }
    }, this.config.heartbeatTimeoutMs);
  }

  private scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer) return;
    const delay = Math.min(
      this.config.reconnectInitialDelayMs * 2 ** this.reconnectAttempts,
      this.config.reconnectMaxDelayMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private restoreActiveWorkflows() {
    for (const [workflowId, active] of this.activeByWorkflowId.entries()) {
      void this.queryStatus(workflowId)
        .then((status) => {
          if (status.status === 'completed') {
            this.finishActive(active, {
              workflowId,
              status: status.status,
              progress: status.progress,
              nodeResults: status.node_results || [],
              error: status.error,
              progressLog: [...active.progressLog],
            });
            return;
          }
          if (status.status === 'failed' || status.status === 'cancelled') {
            this.finishActive(active, new Error(status.error || `工作流状态异常: ${status.status}`));
          }
        })
        .catch(() => {
          // 重连后的第一次查询允许失败，等待后续服务端事件或下次重连。
        });
    }
  }

  private log(...args: unknown[]) {
    if (!this.config.debug) return;
    console.debug('[WorkflowClient]', ...args);
  }
}

export function getWorkflowClient(config?: WorkflowClientConfig) {
  return WorkflowClient.getInstance(config);
}
