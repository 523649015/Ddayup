/**
 * HMDao WebSocket 连接管理器 — 可靠实时通信基础设施
 *
 * 核心能力：
 * 1. 指数退避 + jitter 自动重连（防止 thundering herd）
 * 2. 心跳 ping/pong 保活
 * 3. Page Visibility API 感知 — 页面隐藏时暂停重连，恢复时立即重连
 * 4. 连接状态机：disconnected → connecting → connected → reconnecting → closed
 * 5. 消息序列化/反序列化 + 类型安全回调
 *
 * 用途：
 * - Phase 3 E4: ComfyUI 实时进度推送
 * - Phase 4 C1: Yjs CRDT 多人协作信令
 * - Phase 5 A1: 多 Agent 协作消息总线
 */

import { wrapService, type ServiceResult } from '@/services/serviceErrorBoundary';

// ===== 连接状态 =====

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

// ===== 配置 =====

export interface WSManagerConfig {
  /** WebSocket 服务端 URL */
  url: string;
  /** 重连策略 */
  reconnect: {
    /** 初始重连延迟 (ms) */
    initialDelay: number;
    /** 最大重连延迟 (ms) */
    maxDelay: number;
    /** 最大重连次数，0 表示无限 */
    maxAttempts: number;
    /** 退避因子 (默认 2，即指数退避) */
    backoffFactor: number;
    /** jitter 范围 [0, 1]，0 表示无抖动 */
    jitter: number;
  };
  /** 心跳间隔 (ms)，0 表示禁用心跳 */
  heartbeatInterval: number;
  /** 心跳超时 (ms) — 超过此时间未收到 pong 视为断开 */
  heartbeatTimeout: number;
  /** 连接超时 (ms) */
  connectTimeout: number;
  /** 是否在页面隐藏时暂停重连 */
  pauseOnHidden: boolean;
  /** 调试模式 */
  debug: boolean;
}

const DEFAULT_CONFIG: WSManagerConfig = {
  url: '',
  reconnect: {
    initialDelay: 1000,
    maxDelay: 30000,
    maxAttempts: 0, // 无限重连
    backoffFactor: 2,
    jitter: 0.3,
  },
  heartbeatInterval: 15000,
  heartbeatTimeout: 10000,
  connectTimeout: 10000,
  pauseOnHidden: true,
  debug: false,
};

// ===== 事件回调 =====

export interface WSManagerEvents {
  onMessage?: (data: unknown) => void;
  onStateChange?: (state: ConnectionState, prev: ConnectionState) => void;
  onError?: (error: Event) => void;
  onReconnectAttempt?: (attempt: number, maxAttempts: number) => void;
}

// ===== 计算带 jitter 的重连延迟 =====

function jitteredDelay(baseDelay: number, jitterFactor: number): number {
  if (jitterFactor <= 0) return baseDelay;
  const jitter = baseDelay * jitterFactor * (Math.random() * 2 - 1); // [-jitter, +jitter]
  return Math.max(0, Math.round(baseDelay + jitter));
}

// ===== WebSocket 连接管理器 =====

export class WSManager {
  private ws: WebSocket | null = null;
  private config: WSManagerConfig;
  private events: WSManagerEvents;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private intentionalClose = false;

  constructor(config: Partial<WSManagerConfig> = {}, events: WSManagerEvents = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;

    if (this.config.pauseOnHidden) {
      this.setupVisibilityListener();
    }
  }

  // ===== 公共 API =====

  /** 获取当前连接状态 */
  getState(): ConnectionState {
    return this.state;
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /** 连接 */
  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      this.log('已在连接中，跳过');
      return;
    }

    if (this.state === 'closed') {
      this.log('连接已关闭，无法重新连接');
      return;
    }

    this.intentionalClose = false;
    this.doConnect();
  }

  /** 发送消息 */
  send(data: unknown): boolean {
    if (!this.isConnected()) {
      console.warn('[HMDao WS] 未连接，消息未发送');
      return false;
    }

    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws!.send(payload);
      return true;
    } catch (err) {
      console.error('[HMDao WS] 发送失败:', err);
      return false;
    }
  }

  /** 正常关闭（不触发重连） */
  close(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.ws?.close(1000, 'Client closing');
    this.ws = null;
    this.setState('closed');
  }

  /** 销毁实例 */
  destroy(): void {
    this.close();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  // ===== 内部实现 =====

  private doConnect(): void {
    if (!this.config.url) {
      console.error('[HMDao WS] URL 未配置');
      return;
    }

    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    // 连接超时
    this.connectTimeoutTimer = setTimeout(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.log('连接超时');
        this.ws?.close();
        // onclose 会触发重连
      }
    }, this.config.connectTimeout);

    try {
      this.ws = new WebSocket(this.config.url);
      this.ws.onopen = this.handleOpen;
      this.ws.onmessage = this.handleMessage;
      this.ws.onerror = this.handleError;
      this.ws.onclose = this.handleClose;
    } catch (err) {
      console.error('[HMDao WS] 创建连接失败:', err);
      this.scheduleReconnect();
    }
  }

  private handleOpen = (): void => {
    this.clearConnectTimeout();
    this.reconnectAttempts = 0;
    this.setState('connected');
    this.startHeartbeat();
    this.log('已连接');
  };

  private handleMessage = (event: MessageEvent): void => {
    // 重置心跳超时
    this.resetHeartbeatTimeout();

    let data: unknown;
    try {
      data = JSON.parse(event.data as string);
    } catch {
      data = event.data;
    }

    // 心跳响应检测
    if (typeof data === 'object' && data !== null && (data as Record<string, unknown>).type === 'pong') {
      this.log('收到 pong');
      return;
    }

    this.events.onMessage?.(data);
  };

  private handleError = (event: Event): void => {
    console.error('[HMDao WS] 连接错误:', event);
    this.events.onError?.(event);
  };

  private handleClose = (event: CloseEvent): void => {
    this.clearConnectTimeout();
    this.stopHeartbeat();

    this.log(`连接关闭 (code=${event.code}, reason=${event.reason})`);

    if (this.intentionalClose) {
      this.setState('closed');
      return;
    }

    // 非正常关闭 → 自动重连
    this.scheduleReconnect();
  };

  // ===== 重连逻辑 =====

  private scheduleReconnect(): void {
    const { initialDelay, maxDelay, maxAttempts, backoffFactor, jitter } = this.config.reconnect;

    // 检查是否达到最大重连次数
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      console.error(`[HMDao WS] 已达最大重连次数 (${maxAttempts})，停止重连`);
      this.setState('closed');
      return;
    }

    // 页面隐藏时不重连
    if (this.config.pauseOnHidden && document.hidden) {
      this.log('页面隐藏，暂停重连');
      return;
    }

    this.reconnectAttempts++;
    const baseDelay = Math.min(initialDelay * Math.pow(backoffFactor, this.reconnectAttempts - 1), maxDelay);
    const delay = jitteredDelay(baseDelay, jitter);

    this.log(`第 ${this.reconnectAttempts} 次重连，${delay}ms 后执行`);
    this.events.onReconnectAttempt?.(this.reconnectAttempts, maxAttempts);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  // ===== 心跳 =====

  private startHeartbeat(): void {
    if (this.config.heartbeatInterval <= 0) return;

    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: 'ping', timestamp: Date.now() });
        this.resetHeartbeatTimeout();
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private resetHeartbeatTimeout(): void {
    if (this.config.heartbeatTimeout <= 0) return;

    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
    }

    this.heartbeatTimeoutTimer = setTimeout(() => {
      console.warn('[HMDao WS] 心跳超时，断开重连');
      this.ws?.close(4001, 'Heartbeat timeout');
    }, this.config.heartbeatTimeout);
  }

  // ===== 页面可见性 =====

  private setupVisibilityListener(): void {
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.log('页面隐藏');
        // 暂停重连定时器
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      } else {
        this.log('页面恢复可见');
        // 如果连接断开且不是主动关闭，立即重连
        if (!this.isConnected() && this.state !== 'closed' && !this.intentionalClose) {
          this.reconnectAttempts = 0; // 重置重连计数
          this.doConnect();
        }
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // ===== 状态管理 =====

  private setState(newState: ConnectionState): void {
    const prev = this.state;
    if (prev === newState) return;
    this.state = newState;
    this.events.onStateChange?.(newState, prev);
  }

  // ===== 清理 =====

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private cleanup(): void {
    this.clearConnectTimeout();
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private log(msg: string): void {
    if (this.config.debug) {
      console.log(`[HMDao WS] ${msg}`);
    }
  }
}

// ===== 便捷工厂函数 =====

/**
 * 创建带默认配置的 WSManager 实例
 * 默认启用 jitter 重连 + 心跳 + visibility 感知
 */
export function createWSManager(
  url: string,
  events?: WSManagerEvents,
  overrides?: Partial<WSManagerConfig>,
): WSManager {
  return new WSManager(
    {
      url,
      reconnect: {
        initialDelay: 1000,
        maxDelay: 30000,
        maxAttempts: 0,
        backoffFactor: 2,
        jitter: 0.3,
      },
      heartbeatInterval: 15000,
      heartbeatTimeout: 10000,
      connectTimeout: 10000,
      pauseOnHidden: true,
      debug: false,
      ...overrides,
    },
    events,
  );
}

// ===== 服务包装适配器 =====

/**
 * 将 WSManager.send 包装为 ServiceResult 风格
 * 用于与 serviceErrorBoundary 体系对齐
 */
export async function safeWSSend(
  manager: WSManager,
  data: unknown,
): Promise<ServiceResult<boolean>> {
  try {
    const ok = manager.send(data);
    return { success: ok, data: ok, category: 'network', timestamp: Date.now() };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      category: 'network',
      timestamp: Date.now(),
    };
  }
}
