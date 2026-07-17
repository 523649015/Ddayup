/**
 * HMDao 实时推送集成 — WSManager ↔ Canvas Store 桥接层
 *
 * 核心能力：
 * 1. ComfyUI 工作流执行进度 → 实时更新节点状态
 * 2. 节点生成进度 → 画布 UI 实时刷新
 * 3. 多人协作信令 → 为 Phase 4 C1 Yjs 提供传输层
 * 4. 服务端推送事件分发 → 类型安全的消息路由
 *
 * 架构：
 * - RealtimePushService 单例管理所有实时通道
 * - 消息类型枚举 + 类型安全处理器注册
 * - 自动重连时恢复订阅
 * - 与 Canvas Store 双向绑定
 */

import { WSManager, type WSManagerConfig, type ConnectionState } from '@/services/realtime';
import { wrapService, type ServiceResult } from '@/services/serviceErrorBoundary';
import { classifyError, logError } from '@/engine/safe-fetch';

// ===== 消息类型枚举 =====

export const RealtimeMessageType = {
  // 工作流执行
  WORKFLOW_PROGRESS: 'workflow.progress',
  WORKFLOW_NODE_START: 'workflow.node.start',
  WORKFLOW_NODE_COMPLETE: 'workflow.node.complete',
  WORKFLOW_NODE_ERROR: 'workflow.node.error',
  WORKFLOW_COMPLETE: 'workflow.complete',
  WORKFLOW_FAILED: 'workflow.failed',

  // 节点生成
  NODE_GENERATION_START: 'node.generation.start',
  NODE_GENERATION_PROGRESS: 'node.generation.progress',
  NODE_GENERATION_COMPLETE: 'node.generation.complete',
  NODE_GENERATION_ERROR: 'node.generation.error',

  // 协作信令 (Phase 4 C1)
  COLLAB_JOIN: 'collab.join',
  COLLAB_LEAVE: 'collab.leave',
  COLLAB_CURSOR: 'collab.cursor',
  COLLAB_AWARENESS: 'collab.awareness',

  // 系统
  SYSTEM_HEARTBEAT: 'system.heartbeat',
  SYSTEM_ERROR: 'system.error',
  SYSTEM_RECONNECT: 'system.reconnect',
} as const;

export type RealtimeMessageTypeValue = typeof RealtimeMessageType[keyof typeof RealtimeMessageType];

// ===== 消息结构 =====

export interface RealtimeMessage {
  type: RealtimeMessageTypeValue;
  payload: Record<string, unknown>;
  timestamp: number;
  senderId?: string;
}

export interface WorkflowProgressPayload {
  planId: string;
  completedSteps: number;
  totalSteps: number;
  failedSteps: number;
  percent: number;
  currentNodeLabel?: string;
}

export interface NodeGenerationPayload {
  nodeId: string;
  nodeType: string;
  provider: string;
  model: string;
  percent: number;
  stage: string;
  estimatedRemainingMs?: number;
}

export interface CollabCursorPayload {
  userId: string;
  userName: string;
  x: number;
  y: number;
  color: string;
}

// ===== 消息处理器类型 =====

export type MessageHandler<T = Record<string, unknown>> = (payload: T, message: RealtimeMessage) => void;

// ===== 推送服务配置 =====

export interface RealtimePushConfig {
  /** WebSocket 服务端 URL */
  wsUrl: string;
  /** 是否自动连接 */
  autoConnect: boolean;
  /** 重连时是否自动恢复订阅 */
  autoResubscribe: boolean;
  /** 调试模式 */
  debug: boolean;
}

const DEFAULT_PUSH_CONFIG: RealtimePushConfig = {
  wsUrl: '',
  autoConnect: false,
  autoResubscribe: true,
  debug: false,
};

// ===== 推送服务单例 =====

let instance: RealtimePushService | null = null;

export class RealtimePushService {
  private wsManager: WSManager;
  private config: RealtimePushConfig;
  private handlers = new Map<RealtimeMessageTypeValue, Set<MessageHandler>>();
  private pendingSubscriptions: RealtimeMessageTypeValue[] = [];

  constructor(config: Partial<RealtimePushConfig> = {}) {
    this.config = { ...DEFAULT_PUSH_CONFIG, ...config };

    const wsConfig: Partial<WSManagerConfig> = {
      url: this.config.wsUrl,
      debug: this.config.debug,
    };

    this.wsManager = new WSManager(wsConfig, {
      onMessage: this.handleIncomingMessage,
      onStateChange: this.handleStateChange,
      onError: this.handleWSError,
    });

    if (this.config.autoConnect && this.config.wsUrl) {
      this.connect();
    }
  }

  // ===== 公共 API =====

  /** 获取单例 */
  static getInstance(config?: Partial<RealtimePushConfig>): RealtimePushService {
    if (!instance) {
      instance = new RealtimePushService(config);
    }
    return instance;
  }

  /** 销毁单例 */
  static destroyInstance(): void {
    if (instance) {
      instance.destroy();
      instance = null;
    }
  }

  /** 连接 */
  connect(): void {
    this.wsManager.connect();
  }

  /** 断开 */
  disconnect(): void {
    this.wsManager.close();
  }

  /** 销毁 */
  destroy(): void {
    this.handlers.clear();
    this.pendingSubscriptions = [];
    this.wsManager.destroy();
  }

  /** 获取连接状态 */
  getConnectionState(): ConnectionState {
    return this.wsManager.getState();
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.wsManager.isConnected();
  }

  // ===== 消息订阅 =====

  /**
   * 订阅消息类型
   */
  subscribe<T = Record<string, unknown>>(
    type: RealtimeMessageTypeValue,
    handler: MessageHandler<T>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as MessageHandler);

    // 发送订阅请求到服务端
    this.sendSubscription(type, 'subscribe');

    // 返回取消订阅函数
    return () => {
      this.handlers.get(type)?.delete(handler as MessageHandler);
      if (this.handlers.get(type)?.size === 0) {
        this.handlers.delete(type);
        this.sendSubscription(type, 'unsubscribe');
      }
    };
  }

  /**
   * 一次性监听（收到一次后自动取消）
   */
  once<T = Record<string, unknown>>(
    type: RealtimeMessageTypeValue,
    handler: MessageHandler<T>,
  ): void {
    const unsubscribe = this.subscribe<T>(type, (payload, msg) => {
      unsubscribe();
      handler(payload, msg);
    });
  }

  // ===== 消息发送 =====

  /**
   * 发送消息
   */
  send(type: RealtimeMessageTypeValue, payload: Record<string, unknown> = {}): boolean {
    const message: RealtimeMessage = {
      type,
      payload,
      timestamp: Date.now(),
    };
    return this.wsManager.send(message);
  }

  /**
   * 推送工作流进度
   */
  pushWorkflowProgress(progress: WorkflowProgressPayload): boolean {
    return this.send(RealtimeMessageType.WORKFLOW_PROGRESS, progress as unknown as Record<string, unknown>);
  }

  /**
   * 推送节点生成进度
   */
  pushNodeGenerationProgress(progress: NodeGenerationPayload): boolean {
    return this.send(RealtimeMessageType.NODE_GENERATION_PROGRESS, progress as unknown as Record<string, unknown>);
  }

  /**
   * 推送协作光标位置 (Phase 4 C1)
   */
  pushCollabCursor(cursor: CollabCursorPayload): boolean {
    return this.send(RealtimeMessageType.COLLAB_CURSOR, cursor as unknown as Record<string, unknown>);
  }

  // ===== 内部实现 =====

  private handleIncomingMessage = (data: unknown): void => {
    const msg = data as RealtimeMessage;
    if (!msg || !msg.type) {
      if (this.config.debug) {
        console.warn('[HMDao Push] 收到无效消息:', data);
      }
      return;
    }

    const handlers = this.handlers.get(msg.type as RealtimeMessageTypeValue);
    if (!handlers || handlers.size === 0) {
      if (this.config.debug) {
        console.log(`[HMDao Push] 未处理的消息类型: ${msg.type}`);
      }
      return;
    }

    handlers.forEach((handler) => {
      try {
        handler(msg.payload, msg);
      } catch (err) {
        logError(err instanceof Error ? err : new Error(String(err)), {
          category: classifyError(err),
          module: 'realtimePush',
          function: 'handleIncomingMessage',
          messageType: msg.type,
        });
      }
    });
  };

  private handleStateChange = (state: ConnectionState, prev: ConnectionState): void => {
    if (this.config.debug) {
      console.log(`[HMDao Push] 连接状态: ${prev} → ${state}`);
    }

    // 重连成功后恢复订阅
    if (state === 'connected' && prev === 'reconnecting' && this.config.autoResubscribe) {
      this.resubscribeAll();
    }

    // 通知系统状态变更
    if (state === 'connected') {
      this.send(RealtimeMessageType.SYSTEM_RECONNECT, { prevState: prev });
    }
  };

  private handleWSError = (error: Event): void => {
    logError(new Error('WebSocket error'), {
      category: 'network',
      module: 'realtimePush',
      function: 'handleWSError',
      errorType: error.type,
    });
  };

  private sendSubscription(type: RealtimeMessageTypeValue, action: 'subscribe' | 'unsubscribe'): void {
    if (!this.isConnected()) {
      // 未连接时缓存订阅请求
      if (action === 'subscribe' && !this.pendingSubscriptions.includes(type)) {
        this.pendingSubscriptions.push(type);
      }
      return;
    }

    this.wsManager.send({
      type: `system.${action}`,
      payload: { messageType: type },
      timestamp: Date.now(),
    });
  }

  private resubscribeAll(): void {
    // 恢复所有活跃订阅
    this.handlers.forEach((_, type) => {
      this.sendSubscription(type, 'subscribe');
    });

    // 恢复待处理订阅
    this.pendingSubscriptions.forEach((type) => {
      this.sendSubscription(type, 'subscribe');
    });
    this.pendingSubscriptions = [];
  }
}

// ===== 便捷工厂函数 =====

/**
 * 创建推送服务并自动连接
 */
export function createRealtimePushService(wsUrl: string, debug = false): RealtimePushService {
  return new RealtimePushService({ wsUrl, autoConnect: true, debug });
}

/**
 * 获取或创建全局推送服务单例
 */
export function getRealtimePushService(wsUrl?: string): RealtimePushService {
  return RealtimePushService.getInstance(wsUrl ? { wsUrl, autoConnect: true } : undefined);
}

// ===== 带错误边界的包装 =====

export const safeSendMessage = wrapService(
  async (type: RealtimeMessageTypeValue, payload: Record<string, unknown>) => {
    const service = getRealtimePushService();
    const success = service.send(type, payload);
    if (!success) throw new Error('消息发送失败：WebSocket 未连接');
    return { success, type, timestamp: Date.now() };
  },
  { name: 'realtimePush.send', timeout: 5000, retries: 1 },
);
