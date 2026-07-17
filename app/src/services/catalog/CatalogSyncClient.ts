type CatalogUpdateHandler = () => void;

interface CatalogSyncClientConfig {
  url?: string;
  heartbeatIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

const DEFAULT_CONFIG: Required<CatalogSyncClientConfig> = {
  url: '',
  heartbeatIntervalMs: 15_000,
  reconnectInitialDelayMs: 1_000,
  reconnectMaxDelayMs: 10_000,
};

let singleton: CatalogSyncClient | null = null;

function buildDefaultUrl() {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8792/ws/catalog';
  const explicitUrl = import.meta.env.VITE_HMDAO_CATALOG_WS_URL || (window as typeof window & {
    __HMDAO_CATALOG_WS_URL__?: string;
  }).__HMDAO_CATALOG_WS_URL__;
  if (explicitUrl) return explicitUrl;
  const url = new URL(window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/catalog';
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

export class CatalogSyncClient {
  private config: Required<CatalogSyncClientConfig>;
  private ws: WebSocket | null = null;
  private state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' = 'idle';
  private reconnectAttempts = 0;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private intentionalClose = false;
  private handlers = new Set<CatalogUpdateHandler>();

  constructor(config: CatalogSyncClientConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      url: config.url || buildDefaultUrl(),
    };
  }

  static getInstance(config?: CatalogSyncClientConfig) {
    if (!singleton) singleton = new CatalogSyncClient(config);
    return singleton;
  }

  subscribe(handler: CatalogUpdateHandler) {
    this.handlers.add(handler);
    void this.connect().catch(() => {
      // 连接失败由重连机制兜底
    });
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) this.disconnect();
    };
  }

  private async connect() {
    if (this.state === 'connected' || this.connectPromise) return this.connectPromise;
    this.intentionalClose = false;
    this.state = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.url);
      const timeout = window.setTimeout(() => {
        try { ws.close(); } catch { /* noop */ }
        reject(new Error('Catalog sync WebSocket connect timeout'));
      }, 8_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.state = 'connected';
        this.reconnectAttempts = 0;
        this.connectPromise = null;
        this.startHeartbeat();
        ws.send(JSON.stringify({
          msg_id: nextId('catalog-sub'),
          msg_type: 'catalog:subscribe',
          payload: {},
          ts: Date.now(),
        }));
        resolve();
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let message: { msg_type?: string; payload?: Record<string, unknown> } = {};
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.msg_type === 'pong') return;
        if (message.msg_type === 'catalog:updated') {
          this.handlers.forEach((handler) => handler());
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (this.ws === ws) this.ws = null;
        this.stopHeartbeat();
        this.connectPromise = null;
        if (this.intentionalClose) {
          this.state = 'closed';
          return;
        }
        this.state = 'reconnecting';
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        // 交给 close 统一处理
      };
    }).catch((error) => {
      this.connectPromise = null;
      this.scheduleReconnect();
      throw error;
    });

    return this.connectPromise;
  }

  private disconnect() {
    this.intentionalClose = true;
    this.state = 'closed';
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'catalog sync close'); } catch { /* noop */ }
      this.ws = null;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({
        msg_id: nextId('catalog-ping'),
        msg_type: 'ping',
        payload: {},
        ts: Date.now(),
      }));
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer || this.handlers.size === 0) return;
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
}

export function getCatalogSyncClient(config?: CatalogSyncClientConfig) {
  return CatalogSyncClient.getInstance(config);
}
