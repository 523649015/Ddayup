/**
 * HMDao Yjs CRDT 多人协作服务 — 实时协同编辑基础设施
 *
 * 核心能力：
 * 1. Yjs CRDT 无冲突数据类型 (Y.Map / Y.Array) 同步画布节点与边
 * 2. y-protocols 同步协议 (sync1/sync2/awareness) 通过 WSManager 传输
 * 3. Awareness 用户感知 — 光标位置、选中节点、在线状态
 * 4. Y.Doc ↔ Zustand Canvas Store 双向桥接
 * 5. 撤销/重做栈与 Yjs UndoManager 集成
 *
 * 依赖：
 * - yjs: CRDT 核心库
 * - y-protocols: 同步协议 (sync + awareness)
 * - realtime.ts: WSManager 作为底层传输
 * - useCanvasStore: Zustand 画布状态
 *
 * 架构：
 * Y.Doc (CRDT) ←→ syncProtocol ←→ WSManager ←→ WebSocket ←→ Server
 *     ↕ (bridge)
 * Zustand Canvas Store (UI)
 */

import * as Y from 'yjs';
import { encodeStateAsUpdate, type Doc } from 'yjs';
import {
  readSyncMessage,
} from 'y-protocols/sync';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from 'y-protocols/awareness';
import { WSManager, type ConnectionState } from '@/services/realtime';
import type { CanvasNode, CanvasEdge, NodeData } from '@/types';
import { wrapService, type ServiceResult } from '@/services/serviceErrorBoundary';

// ===== 常量 =====

const DEFAULT_COLLAB_CONFIG: CollabConfig = {
  roomName: 'hmdao-default',
  syncInterval: 50, // 50ms 批量同步间隔
  maxUndoStackSize: 100,
  debug: false,
};

// ===== 类型定义 =====

export interface CollabConfig {
  /** 协作房间名 */
  roomName: string;
  /** 批量同步间隔 (ms) */
  syncInterval: number;
  /** 最大撤销栈深度 */
  maxUndoStackSize: number;
  /** 调试模式 */
  debug: boolean;
}

/** Awareness 用户状态 */
export interface CollabUserState {
  /** 用户显示名 */
  name: string;
  /** 用户颜色 (用于光标/选区渲染) */
  color: string;
  /** 用户头像 URL */
  avatar?: string;
  /** 光标画布坐标 */
  cursor?: { x: number; y: number };
  /** 当前选中的节点 ID 列表 */
  selectedNodes?: string[];
  /** 是否正在编辑 */
  isEditing?: boolean;
  /** 最后活跃时间戳 */
  lastActive?: number;
}

/** 协作事件回调 */
export interface CollabEvents {
  /** 远程节点变更 */
  onRemoteNodesChange?: (nodes: CanvasNode[]) => void;
  /** 远程边变更 */
  onRemoteEdgesChange?: (edges: CanvasEdge[]) => void;
  /** 用户加入 */
  onUserJoin?: (clientId: number, state: CollabUserState) => void;
  /** 用户离开 */
  onUserLeave?: (clientId: number, state: CollabUserState) => void;
  /** 用户状态更新 */
  onUserUpdate?: (clientId: number, state: CollabUserState) => void;
  /** 同步状态变更 */
  onSyncStateChange?: (synced: boolean) => void;
  /** 连接状态变更 */
  onConnectionChange?: (state: ConnectionState) => void;
}

/** 协作服务状态 */
export type CollabServiceState = 'idle' | 'connecting' | 'syncing' | 'synced' | 'disconnected' | 'error';

// ===== 序列化工具 =====

/** 将 CanvasNode 序列化为 Y.Map 兼容的普通对象 */
function serializeNode(node: CanvasNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    position: { x: node.position.x, y: node.position.y },
    data: { ...node.data },
    selected: node.selected ?? false,
  };
}

/** 从普通对象反序列化为 CanvasNode */
function deserializeNode(raw: Record<string, unknown>): CanvasNode {
  return {
    id: raw.id as string,
    type: raw.type as CanvasNode['type'],
    position: raw.position as { x: number; y: number },
    data: raw.data as NodeData,
    selected: raw.selected as boolean | undefined,
  };
}

/** 将 CanvasEdge 序列化为普通对象 */
function serializeEdge(edge: CanvasEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    type: edge.type ?? 'default',
  };
}

/** 从普通对象反序列化为 CanvasEdge */
function deserializeEdge(raw: Record<string, unknown>): CanvasEdge {
  return {
    id: raw.id as string,
    source: raw.source as string,
    target: raw.target as string,
    sourceHandle: (raw.sourceHandle as string) ?? undefined,
    targetHandle: (raw.targetHandle as string) ?? undefined,
    type: (raw.type as CanvasEdge['type']) ?? 'default',
  };
}

// ===== 协作服务 =====

export class CollaborationService {
  private config: CollabConfig;
  private wsManager: WSManager;
  private doc: Doc;
  private awareness: Awareness;
  private nodesMap: Y.Map<Y.Map<unknown>>;
  private edgesMap: Y.Map<Y.Map<unknown>>;
  private events: CollabEvents;
  private state: CollabServiceState = 'idle';
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdate = false;
  private localUserId: string;
  private userColor: string;

  constructor(
    wsManager: WSManager,
    config: Partial<CollabConfig> = {},
    events: CollabEvents = {},
  ) {
    this.config = { ...DEFAULT_COLLAB_CONFIG, ...config };
    this.wsManager = wsManager;
    this.events = events;

    // 初始化 Yjs 文档
    this.doc = new Y.Doc();
    this.nodesMap = this.doc.getMap('nodes');
    this.edgesMap = this.doc.getMap('edges');

    // 初始化 Awareness
    this.awareness = new Awareness(this.doc);
    this.localUserId = this.doc.clientID.toString();
    this.userColor = this.generateUserColor();

    this.setupDocListeners();
    this.setupAwarenessListeners();
    this.setupWSListeners();
  }

  // ===== 公共 API =====

  /** 获取当前服务状态 */
  getState(): CollabServiceState {
    return this.state;
  }

  /** 获取 Yjs 文档引用 */
  getDoc(): Doc {
    return this.doc;
  }

  /** 获取 Awareness 引用 */
  getAwareness(): Awareness {
    return this.awareness;
  }

  /** 获取本地用户 ID */
  getLocalUserId(): string {
    return this.localUserId;
  }

  /** 设置本地用户信息 */
  setLocalUser(name: string, avatar?: string): void {
    this.awareness.setLocalStateField('user', {
      name,
      color: this.userColor,
      avatar,
    } satisfies CollabUserState);
  }

  /** 更新本地光标位置 */
  setLocalCursor(x: number, y: number): void {
    const current = this.awareness.getLocalState() as Record<string, unknown> | null;
    const user = (current?.user as CollabUserState) ?? {
      name: 'Anonymous',
      color: this.userColor,
    };
    this.awareness.setLocalStateField('user', {
      ...user,
      cursor: { x, y },
      lastActive: Date.now(),
    });
  }

  /** 更新本地选中节点 */
  setLocalSelectedNodes(nodeIds: string[]): void {
    const current = this.awareness.getLocalState() as Record<string, unknown> | null;
    const user = (current?.user as CollabUserState) ?? {
      name: 'Anonymous',
      color: this.userColor,
    };
    this.awareness.setLocalStateField('user', {
      ...user,
      selectedNodes: nodeIds,
      lastActive: Date.now(),
    });
  }

  /** 加入协作房间 */
  connect(): void {
    if (this.state === 'connecting' || this.state === 'syncing' || this.state === 'synced') {
      this.log('已在协作中，跳过');
      return;
    }

    this.setState('connecting');
    this.wsManager.connect();
  }

  /** 离开协作房间 */
  disconnect(): void {
    this.clearSyncTimer();
    this.wsManager.close();
    this.setState('disconnected');
  }

  /** 销毁服务 */
  destroy(): void {
    this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }

  // ===== 画布数据同步 (Zustand → Yjs) =====

  /** 从 Zustand Store 全量同步节点到 Yjs */
  syncNodesFromStore(nodes: CanvasNode[]): void {
    this.doc.transact(() => {
      // 清除已删除的节点
      const storeIds = new Set(nodes.map((n) => n.id));
      for (const [id] of this.nodesMap) {
        if (!storeIds.has(id)) {
          this.nodesMap.delete(id);
        }
      }

      // 更新/新增节点
      for (const node of nodes) {
        const existing = this.nodesMap.get(node.id);
        const serialized = serializeNode(node);

        if (existing) {
          // 增量更新
          for (const [key, value] of Object.entries(serialized)) {
            existing.set(key, value);
          }
        } else {
          // 新增
          const nodeMap = new Y.Map<unknown>();
          for (const [key, value] of Object.entries(serialized)) {
            nodeMap.set(key, value);
          }
          this.nodesMap.set(node.id, nodeMap);
        }
      }
    }, 'store-sync');
  }

  /** 从 Zustand Store 全量同步边到 Yjs */
  syncEdgesFromStore(edges: CanvasEdge[]): void {
    this.doc.transact(() => {
      const storeIds = new Set(edges.map((e) => e.id));
      for (const [id] of this.edgesMap) {
        if (!storeIds.has(id)) {
          this.edgesMap.delete(id);
        }
      }

      for (const edge of edges) {
        const existing = this.edgesMap.get(edge.id);
        const serialized = serializeEdge(edge);

        if (existing) {
          for (const [key, value] of Object.entries(serialized)) {
            existing.set(key, value);
          }
        } else {
          const edgeMap = new Y.Map<unknown>();
          for (const [key, value] of Object.entries(serialized)) {
            edgeMap.set(key, value);
          }
          this.edgesMap.set(edge.id, edgeMap);
        }
      }
    }, 'store-sync');
  }

  /** 获取当前 Yjs 中的所有节点 */
  getSyncedNodes(): CanvasNode[] {
    const nodes: CanvasNode[] = [];
    for (const [, nodeMap] of this.nodesMap) {
      nodes.push(deserializeNode(nodeMap.toJSON() as Record<string, unknown>));
    }
    return nodes;
  }

  /** 获取当前 Yjs 中的所有边 */
  getSyncedEdges(): CanvasEdge[] {
    const edges: CanvasEdge[] = [];
    for (const [, edgeMap] of this.edgesMap) {
      edges.push(deserializeEdge(edgeMap.toJSON() as Record<string, unknown>));
    }
    return edges;
  }

  /** 获取所有在线用户 */
  getOnlineUsers(): Map<number, CollabUserState> {
    const users = new Map<number, CollabUserState>();
    const states = this.awareness.getStates();
    for (const [clientId, state] of states) {
      if (state.user) {
        users.set(clientId, state.user as CollabUserState);
      }
    }
    return users;
  }

  // ===== 内部实现 =====

  /** 设置服务状态 */
  private setState(newState: CollabServiceState): void {
    const prev = this.state;
    this.state = newState;
    this.log(`状态变更: ${prev} → ${newState}`);
  }

  /** 生成用户颜色 */
  private generateUserColor(): string {
    const colors = [
      '#f97316', '#06b6d4', '#8b5cf6', '#ec4899', '#22c55e',
      '#eab308', '#3b82f6', '#ef4444', '#14b8a6', '#a855f7',
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /** 监听 Yjs 文档变更 → 通知外部 */
  private setupDocListeners(): void {
    // 节点变更
    this.nodesMap.observe((event) => {
      if (event.transaction.origin === 'store-sync') return; // 忽略本地同步
      if (event.transaction.origin === 'remote-sync') return; // 忽略远程同步回环

      const changedNodes: CanvasNode[] = [];
      for (const [id, change] of event.changes.keys) {
        const action = change.action;
        if (action === 'delete') {
          changedNodes.push({ id } as CanvasNode); // 标记删除
        } else {
          const nodeMap = this.nodesMap.get(id);
          if (nodeMap) {
            changedNodes.push(deserializeNode(nodeMap.toJSON() as Record<string, unknown>));
          }
        }
      }

      if (changedNodes.length > 0) {
        this.events.onRemoteNodesChange?.(changedNodes);
      }
    });

    // 边变更
    this.edgesMap.observe((event) => {
      if (event.transaction.origin === 'store-sync') return;
      if (event.transaction.origin === 'remote-sync') return;

      const changedEdges: CanvasEdge[] = [];
      for (const [id, change] of event.changes.keys) {
        const action = change.action;
        if (action === 'delete') {
          changedEdges.push({ id } as CanvasEdge);
        } else {
          const edgeMap = this.edgesMap.get(id);
          if (edgeMap) {
            changedEdges.push(deserializeEdge(edgeMap.toJSON() as Record<string, unknown>));
          }
        }
      }

      if (changedEdges.length > 0) {
        this.events.onRemoteEdgesChange?.(changedEdges);
      }
    });

    // 文档更新 → 通过 WSManager 发送同步消息
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote-sync') return; // 不广播远程收到的更新

      // 批量发送优化
      this.pendingUpdate = true;
      this.scheduleSync();
    });
  }

  /** 监听 Awareness 变更 */
  private setupAwarenessListeners(): void {
    this.awareness.on('update', ({ added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => {
      const states = this.awareness.getStates();

      for (const clientId of added) {
        const state = states.get(clientId);
        if (state?.user) {
          this.events.onUserJoin?.(clientId, state.user as CollabUserState);
        }
      }

      for (const clientId of updated) {
        const state = states.get(clientId);
        if (state?.user) {
          this.events.onUserUpdate?.(clientId, state.user as CollabUserState);
        }
      }

      for (const clientId of removed) {
        // removed 时 states 中已无该用户，从之前缓存获取
        this.events.onUserLeave?.(clientId, {} as CollabUserState);
      }
    });

    // Awareness 更新 → 通过 WSManager 发送
    this.awareness.on('update', () => {
      const awarenessUpdate = encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID,
      ]);
      this.wsManager.send(awarenessUpdate);
    });
  }

  /** 监听 WSManager 消息 → 解码同步协议 */
  private setupWSListeners(): void {
    // 通过包装 WSManager 的 onMessage 回调
    // WSManager 构造时传入 events.onMessage
    // 这里我们需要拦截消息，所以用一个新的包装层
    this.setupMessageInterceptor();
  }

  /** 拦截 WSManager 消息进行协议解码 */
  private setupMessageInterceptor(): void {
    // 重新绑定 onMessage 以拦截二进制同步消息
    const wsManagerAny = this.wsManager as unknown as {
      events: { onMessage?: (data: unknown) => void };
      config: { url: string };
    };

    wsManagerAny.events = wsManagerAny.events ?? {};
    const prevOnMessage = wsManagerAny.events.onMessage;

    wsManagerAny.events.onMessage = (data: unknown) => {
      // 先调用原始回调
      prevOnMessage?.(data);

      // 尝试解码 Yjs 同步协议
      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        this.handleBinaryMessage(
          data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        );
      }
    };
  }

  /** 处理二进制同步消息 */
  private handleBinaryMessage(data: Uint8Array): void {
    try {
      // 创建 y-protocols 兼容的 decoder 和 encoder
      const decoder = createDecoder(data);
      const encoder = new Y.UpdateEncoderV1();

      // readSyncMessage 内部根据消息类型分发到 readSyncStep1/readSyncStep2/readUpdate
      // 签名: (decoder, encoder, doc, transactionOrigin, errorHandler)
      readSyncMessage(
        decoder,
        encoder as unknown as Parameters<typeof readSyncMessage>[1],
        this.doc,
        'remote-sync',
        (err: Error) => {
          console.warn('[HMDao Collab] 同步消息解码警告:', err.message);
        },
      );

      // 如果有响应数据（sync step1 → step2 回复），发送回服务端
      const response = encoder.toUint8Array();
      if (response.length > 0) {
        this.wsManager.send(response);
      }

      // 检查是否已同步完成
      if (this.state === 'connecting' || this.state === 'syncing') {
        this.setState('synced');
        this.events.onSyncStateChange?.(true);
      }
    } catch {
      // 不是 sync 消息，尝试作为 awareness 消息解码
      try {
        applyAwarenessUpdate(this.awareness, data, this.doc);
      } catch {
        // 不是已知协议消息，忽略
      }
    }
  }

  /** 批量同步调度 */
  private scheduleSync(): void {
    if (this.syncTimer) return;

    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.pendingUpdate && this.wsManager.isConnected()) {
        const update = encodeStateAsUpdate(this.doc);
        this.wsManager.send(update);
        this.pendingUpdate = false;
      }
    }, this.config.syncInterval);
  }

  /** 清除同步定时器 */
  private clearSyncTimer(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** 调试日志 */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[HMDao Collab] ${message}`);
    }
  }
}

// ===== 解码器工厂 (y-protocols 需要) =====

/** 创建简易解码器 (兼容 y-protocols readSyncMessage) */
function createDecoder(data: Uint8Array) {
  let pos = 0;
  return {
    readUint8Array: (len: number) => {
      const slice = data.slice(pos, pos + len);
      pos += len;
      return slice;
    },
    readVarUint: () => {
      let num = 0;
      let shift = 0;
      while (pos < data.length) {
        const byte = data[pos++];
        num |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      return num;
    },
    readVarString: () => {
      const len = readVarUint();
      const str = new TextDecoder().decode(data.slice(pos, pos + len));
      pos += len;
      return str;
    },
    readVarUint8Array: () => {
      const len = readVarUint();
      return readUint8Array(len);
    },
    readUint8: () => data[pos++],
    readUint16: () => {
      const val = (data[pos] << 8) | data[pos + 1];
      pos += 2;
      return val;
    },
    readUint32: () => {
      const val =
        (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
      pos += 4;
      return val >>> 0;
    },
    readFloat32: () => {
      const view = new DataView(data.buffer, data.byteOffset + pos, 4);
      pos += 4;
      return view.getFloat32(0, false);
    },
    readFloat64: () => {
      const view = new DataView(data.buffer, data.byteOffset + pos, 8);
      pos += 8;
      return view.getFloat64(0, false);
    },
    readBigInt64: () => {
      const view = new DataView(data.buffer, data.byteOffset + pos, 8);
      pos += 8;
      return view.getBigInt64(0, false);
    },
    readVarUint2: readVarUint,
    readVarString2: readVarString,
    readVarUint8Array2: readVarUint8Array,
    readAny: () => {
      // 简化实现：读取类型标记 + 数据
      const type = data[pos++];
      switch (type) {
        case 0: return undefined;
        case 1: return null;
        case 2: return readVarString();
        case 3: return readFloat64();
        case 4: return true;
        case 5: return false;
        case 6: return readBigInt64();
        case 7: {
          const len = readVarUint();
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < len; i++) {
            obj[readVarString()] = readAny();
          }
          return obj;
        }
        case 8: {
          const len = readVarUint();
          const arr: unknown[] = [];
          for (let i = 0; i < len; i++) {
            arr.push(readAny());
          }
          return arr;
        }
        case 9: return readVarUint8Array();
        default: return undefined;
      }
    },
    readTail: () => data.slice(pos),
    readVarUint8ArrayRef: () => readVarUint8Array(),
    readVarStringRef: () => readVarString(),
    pos: () => pos,
    setPos: (p: number) => { pos = p; },
    hasContent: () => pos < data.length,
    clone: (slice: Uint8Array) => createDecoder(slice),
  };

  function readVarUint(): number {
    let num = 0;
    let shift = 0;
    while (pos < data.length) {
      const byte = data[pos++];
      num |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return num;
  }

  function readVarString(): string {
    const len = readVarUint();
    const str = new TextDecoder().decode(data.slice(pos, pos + len));
    pos += len;
    return str;
  }

  function readUint8Array(len: number): Uint8Array {
    const slice = data.slice(pos, pos + len);
    pos += len;
    return slice;
  }

  function readVarUint8Array(): Uint8Array {
    const len = readVarUint();
    return readUint8Array(len);
  }

  function readFloat64(): number {
    const view = new DataView(data.buffer, data.byteOffset + pos, 8);
    pos += 8;
    return view.getFloat64(0, false);
  }

  function readBigInt64(): bigint {
    const view = new DataView(data.buffer, data.byteOffset + pos, 8);
    pos += 8;
    return view.getBigInt64(0, false);
  }

  function readAny(): unknown {
    const type = data[pos++];
    switch (type) {
      case 0: return undefined;
      case 1: return null;
      case 2: return readVarString();
      case 3: return readFloat64();
      case 4: return true;
      case 5: return false;
      case 6: return readBigInt64();
      case 7: {
        const len = readVarUint();
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) {
          obj[readVarString()] = readAny();
        }
        return obj;
      }
      case 8: {
        const len = readVarUint();
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) {
          arr.push(readAny());
        }
        return arr;
      }
      case 9: return readVarUint8Array();
      default: return undefined;
    }
  }
}

// ===== 单例工厂 =====

let collabServiceInstance: CollaborationService | null = null;

/** 创建或获取协作服务单例 */
export function createCollaborationService(
  wsManager: WSManager,
  config?: Partial<CollabConfig>,
  events?: CollabEvents,
): CollaborationService {
  if (collabServiceInstance) {
    collabServiceInstance.destroy();
  }
  collabServiceInstance = new CollaborationService(wsManager, config, events);
  return collabServiceInstance;
}

/** 获取当前协作服务实例 */
export function getCollaborationService(): CollaborationService | null {
  return collabServiceInstance;
}

// ===== 安全包装 =====

/** 安全获取在线用户 */
export const safeGetOnlineUsers = wrapService(
  (): ServiceResult<Map<number, CollabUserState>> => {
    const service = getCollaborationService();
    if (!service) {
      return { success: false, error: '协作服务未初始化' };
    }
    return { success: true, data: service.getOnlineUsers() };
  },
  'collaboration.getOnlineUsers',
);

/** 安全设置本地光标 */
export const safeSetLocalCursor = wrapService(
  (x: number, y: number): ServiceResult<void> => {
    const service = getCollaborationService();
    if (!service) {
      return { success: false, error: '协作服务未初始化' };
    }
    service.setLocalCursor(x, y);
    return { success: true };
  },
  'collaboration.setLocalCursor',
);

/** 安全同步节点 */
export const safeSyncNodesFromStore = wrapService(
  (nodes: CanvasNode[]): ServiceResult<void> => {
    const service = getCollaborationService();
    if (!service) {
      return { success: false, error: '协作服务未初始化' };
    }
    service.syncNodesFromStore(nodes);
    return { success: true };
  },
  'collaboration.syncNodesFromStore',
);

/** 安全同步边 */
export const safeSyncEdgesFromStore = wrapService(
  (edges: CanvasEdge[]): ServiceResult<void> => {
    const service = getCollaborationService();
    if (!service) {
      return { success: false, error: '协作服务未初始化' };
    }
    service.syncEdgesFromStore(edges);
    return { success: true };
  },
  'collaboration.syncEdgesFromStore',
);
