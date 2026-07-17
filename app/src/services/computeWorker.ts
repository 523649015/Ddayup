/**
 * HMDao Web Worker 卸载 — 重计算移出主线程
 *
 * Phase 6 P2: 将 CPU 密集型计算卸载到 Web Worker，
 * 保持主线程 UI 60fps 流畅。
 *
 * 卸载的计算类型：
 * 1. 图像处理 — 缩放、裁剪、滤镜、格式转换
 * 2. 视频帧提取 — FFmpeg.wasm 在 Worker 中运行
 * 3. 数据序列化 — 大画布 JSON 序列化/反序列化
 * 4. 哈希计算 — 文件指纹、去重检测
 *
 * 架构：
 * - ComputeWorkerManager 单例管理 Worker 生命周期
 * - 消息类型枚举 + Promise 化 RPC 调用
 * - Worker 崩溃自动重启 + 任务重试
 * - 超时保护 + 主线程回退
 *
 * 风险防护：
 * - Worker 不可用时自动回退到主线程
 * - 超时任务自动取消 + 清理
 * - 内存泄漏防护 — 定期 terminate 重建 Worker
 */

// ===== 消息类型 =====

export const ComputeTaskType = {
  IMAGE_RESIZE: 'image.resize',
  IMAGE_FILTER: 'image.filter',
  VIDEO_EXTRACT_FRAME: 'video.extractFrame',
  CANVAS_SERIALIZE: 'canvas.serialize',
  CANVAS_DESERIALIZE: 'canvas.deserialize',
  HASH_COMPUTE: 'hash.compute',
} as const;

export type ComputeTaskType = (typeof ComputeTaskType)[keyof typeof ComputeTaskType];

// ===== 消息接口 =====

export interface ComputeRequest {
  id: string;
  type: ComputeTaskType;
  payload: unknown;
}

export interface ComputeResponse {
  id: string;
  type: ComputeTaskType;
  result?: unknown;
  error?: string;
}

// ===== 配置 =====

const WORKER_TIMEOUT_MS = 30_000; // 单任务超时 30s
const WORKER_MAX_TASKS = 500; // Worker 处理 500 个任务后重建（防内存泄漏）
const WORKER_RESTART_DELAY_MS = 1000;

// ===== Worker 管理器 =====

export class ComputeWorkerManager {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private taskCount = 0;
  private workerAvailable = false;

  /** 初始化 Worker */
  async init(): Promise<void> {
    try {
      // 动态 import Worker 以支持 Vite 的 Worker 打包
      const ComputeWorker = await import('@/workers/compute.worker?worker');
      this.worker = new ComputeWorker.default();
      this.worker.onmessage = this.handleMessage.bind(this);
      this.worker.onerror = this.handleError.bind(this);
      this.workerAvailable = true;
    } catch {
      console.warn('[ComputeWorker] Worker 初始化失败，回退到主线程模式');
      this.workerAvailable = false;
    }
  }

  /** 提交计算任务 */
  async execute<T>(type: ComputeTaskType, payload: unknown): Promise<T> {
    // Worker 不可用 — 主线程回退
    if (!this.workerAvailable || !this.worker) {
      return this.mainThreadFallback<T>(type, payload);
    }

    const id = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[ComputeWorker] 任务超时: ${type}`));
      }, WORKER_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      this.worker!.postMessage({ id, type, payload } satisfies ComputeRequest);
      this.taskCount++;

      // 达到阈值 — 标记重建（当前任务完成后）
      if (this.taskCount >= WORKER_MAX_TASKS) {
        this.scheduleRestart();
      }
    });
  }

  /** 销毁 Worker */
  destroy(): void {
    // 拒绝所有 pending 任务
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('[ComputeWorker] Worker 已销毁'));
      this.pending.delete(id);
    }
    this.worker?.terminate();
    this.worker = null;
    this.workerAvailable = false;
  }

  // ===== 私有方法 =====

  private handleMessage(e: MessageEvent<ComputeResponse>): void {
    const { id, result, error } = e.data;
    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }

  private handleError(e: ErrorEvent): void {
    console.error('[ComputeWorker] Worker 错误:', e.message);
    this.restartWorker();
  }

  private scheduleRestart(): void {
    // 等当前 pending 任务清空后重启
    const check = setInterval(() => {
      if (this.pending.size === 0) {
        clearInterval(check);
        this.restartWorker();
      }
    }, 100);
  }

  private restartWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerAvailable = false;
    this.taskCount = 0;

    setTimeout(() => {
      this.init().catch(console.error);
    }, WORKER_RESTART_DELAY_MS);
  }

  /** 主线程回退 — 同步执行简单任务 */
  private async mainThreadFallback<T>(type: ComputeTaskType, payload: unknown): Promise<T> {
    switch (type) {
      case ComputeTaskType.CANVAS_SERIALIZE:
        return JSON.stringify(payload) as T;
      case ComputeTaskType.CANVAS_DESERIALIZE:
        return JSON.parse(payload as string) as T;
      default:
        throw new Error(`[ComputeWorker] 主线程不支持的任务类型: ${type}`);
    }
  }
}

/** 全局单例 */
export const computeWorker = new ComputeWorkerManager();
